/*global jQuery*/

require('./adapter');

var get = Ember.get, set  = Ember.set;

var Node = function(model) {
  this.dirty = false;
  this.model = model;
  this.children = Ember.Set.create();
  this.parents = Ember.Set.create();
};

Node.prototype = {
  addChild: function(childNode) {
    this.children.add(childNode);
    childNode.parents.add(this);
  },

  isRoot: function() {
    return this.parents.every(function(parent) {
      return !get(parent, 'dirty') && parent.isRoot();
    });
  }
};

/**
  The REST adapter allows your store to communicate with an HTTP server by
  transmitting JSON via XHR. Most Ember.js apps that consume a JSON API
  should use the REST adapter.

  This adapter is designed around the idea that the JSON exchanged with
  the server should be conventional.

  ## JSON Structure

  The REST adapter expects the JSON returned from your server to follow
  these conventions.

  ### Object Root

  The JSON payload should be an object that contains the record inside a
  root property. For example, in response to a `GET` request for
  `/posts/1`, the JSON should look like this:

  ```js
  {
    "post": {
      title: "I'm Running to Reform the W3C's Tag",
      author: "Yehuda Katz"
    }
  }
  ```

  ### Conventional Names

  Attribute names in your JSON payload should be the underscored versions of
  the attributes in your Ember.js models.

  For example, if you have a `Person` model:

  ```js
  App.Person = Ep.Model.extend({
    firstName: Ep.attr('string'),
    lastName: Ep.attr('string'),
    occupation: Ep.attr('string')
  });
  ```

  The JSON returned should look like this:

  ```js
  {
    "person": {
      "first_name": "Barack",
      "last_name": "Obama",
      "occupation": "President"
    }
  }
  ```

  @class RESTAdapter
  @constructor
  @namespace DS
  @extends Ep.Adapter
*/
Ep.RestAdapter = Ep.Adapter.extend({
  init: function() {
    this._super.apply(this, arguments);
  },

  load: function(type, id) {
    var cached = this.store.getForId(type, id)
    // check for store cache hit
    if(cached && get(cached, 'isLoaded')) {
      return Ember.RSVP.resolve(cached);
    }
    var root = this.rootForType(type), adapter = this;

    return this.ajax(this.buildURL(root, id), "GET").then(function(json){
      return Ember.run(adapter, 'didReceiveDataForLoad', json, type, id);
    }, function(xhr) {
      // TODO: set 404
      throw xhr;
    });
  },

  refresh: function(model) {
    var type = get(model, 'type');
    var root = this.rootForType(type), adapter = this;
    var id = get(model, 'id');

    return this.ajax(this.buildURL(root, id), "GET").then(function(json){
      return Ember.run(adapter, 'didReceiveData', json, model);
    }, function(xhr) {
      // TODO: handle deletion
      throw xhr;
    });
  },

  update: function(model) {
    var id, root, adapter, data, type = get(model, 'type');

    id = get(model, 'id');
    root = this.rootForType(type);
    adapter = this;

    data = {};
    data[root] = get(this, 'serializer').serialize(model);

    return this.ajax(this.buildURL(root, id), "PUT",{
      data: data
    }).then(function(json){
      return Ember.run(adapter, 'didReceiveData', json, model);
    }, function(xhr) {
      Ember.run(adapter, 'didError', xhr, model);
      throw xhr;
    });
  },

  create: function(model) {
    var type = get(model, 'type');
    var root = this.rootForType(type);
    var adapter = this;
    var data = {};

    data[root] = get(this, 'serializer').serialize(model, { includeId: true });

    return this.ajax(this.buildURL(root), "POST", {
      data: data
    }).then(function(json){
      return Ember.run(adapter, 'didReceiveData', json, model);
    }, function(xhr) {
      Ember.run(adapter, 'didError', xhr, model);
      throw xhr;
    });
  },

  deleteModel: function(model) {
    var id, root, adapter, type = get(model, 'type');

    id = get(model, 'id');
    root = this.rootForType(type);
    adapter = this;

    return this.ajax(this.buildURL(root, id), "DELETE").then(function(json){
      return Ember.run(adapter, 'didReceiveData', json, model);
    }, function(xhr){
      Ember.run(adapter, 'didError', xhr, model);
      throw xhr;
    });
  },

  find: function(type, query) {
    var root = this.rootForType(type),
    adapter = this;

    return this.ajax(this.buildURL(root), "GET", {
      data: query
    }).then(function(json){
      return Ember.run(adapter, 'didReceiveDataForFind', json, type);
    }, function(xhr) {
      throw xhr;
    });
  },

  didReceiveData: function(data, targetModel) {
    var models = get(this, 'serializer').deserialize(data);
    var result = null;
    models.forEach(function(model) {
      this.loaded(model);
      if(targetModel && model.isSameType(targetModel) && model.equals(targetModel)) {
        result = model;
      }
    }, this);
    return result || targetModel;
  },

  didReceiveDataForLoad: function(data, type, id) {
    var models = get(this, 'serializer').deserialize(data);
    var result = null;
    models.forEach(function(model) {
      this.loaded(model);
      if(model.hasType(type) && get(model, 'id') === id) {
        result = model;
      }
    }, this);
    if(!result) {
      throw new Ember.Error("No data received for " + type.toString() + " with id " + id + ". Server should return 404 instead.");
    }
    return result;
  },

  didReceiveDataForFind: function(data, type) {
    var models = get(this, 'serializer').deserialize(data);
    var result = [];
    // TODO: how to distinguish find results vs. sideloads?
    models.forEach(function(model) {
      this.loaded(model);
      if(model.hasType(type)) {
        result.pushObject(model);
      }
    }, this);
    return Ep.ModelArray.create({content: result});
  },

  didError: function(xhr, model) {
    var json = JSON.parse(xhr.responseText),
        serializer = get(this, 'serializer'),
        errors = serializer.extractValidationErrors(get(model, 'type'), json);

    return set(model, 'errors', errors);
  },

  flush: function(session) {
    var adapter = this;

    var rootNodes = this._createDependencyGraph(session);

    var cumulative = [];

    function createNestedPromise(node) {
      var promise;
      var dirtyType = adapter.dirtyType(node.model);
      var model = node.model;
      if(!dirtyType) {
        // return an "identity" promise if we don't want to do anything
        promise = Ember.RSVP.resolve(model);
      } else if(dirtyType === "created") {
        promise = adapter.create(model);
      } else if(dirtyType === "updated") {
        promise = adapter.update(model);
      } else if(dirtyType === "deleted") {
        promise = adapter.deleteModel(model);
      }
      // keep track of all models for the resolution of the entire flush
      promise = promise.then(function(model) {
        cumulative.push(model);
        return model;
      });
      if(node.children.length > 0) {
        promise = promise.then(function(model) {
          var childPromises = node.children.map(createNestedPromise);
          return Ember.RSVP.all(childPromises).then(function(models) {
            adapter.rebuildRelationships(models, model);
            // TODO: we return just the model here instead of all models,
            // this works because of the cumulative scoped variable
            // we should try and clean this up
            return model;
          });
        });
      }
      return promise;
    }

    return Ember.RSVP.all(rootNodes.map(createNestedPromise)).then(function() {
      return cumulative;
    }, function(err) {
      console.error(err.toString());
      throw err;
    });
  },

  /**
    This callback is intendended to resolve the request ordering issue
    for parent models. For instance, when we have a Post -> Comments
    relationship, the parent post will be saved first. The request will
    return and it is likely that the returned JSON will have no comments.

    In this callback we re-evaluate the relationships after the children
    have been saved, effectively undoing the erroneous relationship results
    of the parent request.
  */
  rebuildRelationships: function(children, parent) {
    parent.suspendRelationshipObservers(function() {
      // TODO: figure out a way to preserve ordering (or screw ordering and use sets)
      for(var i = 0; i < children.length; i++) {
        var child = children[i];

        // TODO: handle deletes as well
        child.eachRelationship(function(name, relationship) {
          // TODO: handle hasMany's for non-relational databases...
          if(relationship.kind === 'belongsTo') {
            var value = get(child, name);
            var inverse = child.constructor.inverseFor(name);
            if(value && inverse && value.equals(parent)) {
              // TODO: make sure it doesn't already exists (or change model arrays to sets)
              // TODO: think about 1-1 relationships
              if(inverse.kind === 'hasMany') {
                get(parent, inverse.name).addObject(child);
              }
            }
          }
        });
      }
    });
  },

  _createDependencyGraph: function(session) {
    var adapter = this;
    var nodes = Ember.MapWithDefault.create({
      defaultValue: function(model) {
        return new Node(model);
      }
    });

    var dirty = Ember.OrderedSet.create();

    session.get('models').forEach(function(model) {

      // skip any promises that aren't loaded
      // TODO: think through edge cases in depth
      if(!get(model, 'isLoaded')) {
        return;
      }

      var rels = [];
      var node = nodes.get(model);

      // if new, all relationships dirty
      // otherwise, compute based on a diff
      if(get(model, 'isNew')) {
        node.dirty = true;
        model.eachRelationship(function(name, relationship) {
          if(relationship.kind === 'belongsTo') {
            rels.push(name);
          }
        }, this);
      } else if(get(model, 'isDeleted')) {
        node.dirty = true;
      } else {
        var cached = this.store.getForId(get(model, 'type'), get(model, 'id'));
        var diff = model.diff(cached);
        for(var i = 0; i < diff.length; i++) {
          var d = diff[i];
          if(d.type === 'attr') {
            node.dirty = true;
          } else if(d.type === 'belongsTo') {
            rels.push(d.name);
          }
        }
      }

      for(var i = 0; i < rels.length; i++) {
        var name = rels[i];
        var parentModel = model.get(name);
        // TODO: handle embedded records
        // TODO: handle hasMany's depending on adapter configuration
        //   // In the non-embedded case, there is a potential request race
        //   // condition where the parent returns the id of a deleted child.
        //   // To solve for this we make the child delete complete first.
        //   if(r.changeType === 'remove' && adapter.shouldSave(childNode.record) && adapter.shouldSave(parentNode.record)) {
        //     childNode.addChild(parentNode);
        //   } else {
        //     parentNode.addChild(childNode);
        //   }
        if(parentModel) {
          var parentNode = nodes.get(parentModel);
          parentNode.addChild(node);
        }
      }

    }, this);

    var rootNodes = Ember.Set.create();

    nodes.forEach(function(model, node) {
      var node = nodes.get(model);
      if(node.dirty && node.isRoot()) {
        rootNodes.add(node);
      }
    }, this);

    return rootNodes;
  },

  isDirtyFromRelationships: function(model, cached, diff) {
    // TODO allow adapter configuration to determine which
    // side of the relationship becomes dirty
    return this._super(model, cached, diff);
  },

  dirtyRecordsForHasManyChange: function(dirtySet, record, relationship) {
    var embeddedType = get(this, 'serializer').embeddedType(record.constructor, relationship.secondRecordName);

    if (embeddedType === 'always') {
      relationship.childReference.parent = relationship.parentReference;
      this._dirtyTree(dirtySet, record);
    }
  },

  _dirtyTree: function(dirtySet, record) {
    dirtySet.add(record);

    get(this, 'serializer').eachEmbeddedRecord(record, function(embeddedRecord, embeddedType) {
      if (embeddedType !== 'always') { return; }
      if (dirtySet.has(embeddedRecord)) { return; }
      this._dirtyTree(dirtySet, embeddedRecord);
    }, this);

    var reference = record.get('_reference');

    if (reference.parent) {
      var store = get(record, 'store');
      var parent = store.recordForReference(reference.parent);
      this._dirtyTree(dirtySet, parent);
    }
  },

  ajax: function(url, type, hash) {
    try {
      hash = hash || {};
      hash.url = url;
      hash.type = type;
      hash.dataType = 'json';
      hash.context = this;

      if (hash.data && type !== 'GET') {
        hash.contentType = 'application/json; charset=utf-8';
        hash.data = JSON.stringify(hash.data);
      }

      return Ember.RSVP.resolve(jQuery.ajax(hash));
    } catch (error) {
      return Ember.RSVP.resolve(error);
    }
  },

  url: "",

  rootForType: function(type) {
    var serializer = get(this, 'serializer');
    return serializer.rootForType(type);
  },

  pluralize: function(string) {
    var serializer = get(this, 'serializer');
    return serializer.pluralize(string);
  },

  buildURL: function(record, suffix) {
    var url = [this.url];

    Ember.assert("Namespace URL (" + this.namespace + ") must not start with slash", !this.namespace || this.namespace.toString().charAt(0) !== "/");
    Ember.assert("Record URL (" + record + ") must not start with slash", !record || record.toString().charAt(0) !== "/");
    Ember.assert("URL suffix (" + suffix + ") must not start with slash", !suffix || suffix.toString().charAt(0) !== "/");

    if (!Ember.isNone(this.namespace)) {
      url.push(this.namespace);
    }

    url.push(this.pluralize(record));
    if (suffix !== undefined) {
      url.push(suffix);
    }

    return url.join("/");
  },

  sinceQuery: function(since) {
    var query = {};
    query[get(this, 'since')] = since;
    return since ? query : null;
  }
});