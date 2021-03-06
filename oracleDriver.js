var optionalRequire = require('./optionalRequire');
var promisify = require('./promisify');
var debug = require('debug')('sworm:oracle');
var swormDebug = require('debug')('sworm');
var _ = require('underscore');
var urlUtils = require('url');
var redactConfig = require('./redactConfig');

module.exports = function () {
  var oracledb = optionalRequire('oracledb');


  return {
    query: function (query, params, options) {
      var results = this.execute(replaceParameters(query), params, _.extend({outFormat: oracledb.ARRAY}, options));

      if (options && (options.statement || options.insert || options.formatRows == false)) {
        return results;
      } else {
        return results.then(function (r) {
          return formatRows(r);
        });
      }
    },

    execute: function (query, params, options) {
      var self = this;
      debug(query, params);
      return promisify(function (cb) {
        self.connection.execute(query, params || {}, options, cb)
      });
    },

    insert: function(query, params, options) {
      var id = options.id;

      return this.query(query + " returning " + id + " into :returning_into_id", params, options).then(function (rows) {
        return rows.outBinds.returning_into_id[0];
      });
    },

    connect: function (swormConfig) {
      var self = this;
      var config = swormConfig.url? parseUrl(swormConfig.url): swormConfig.config;

      if (config.options) {
        Object.keys(config.options).forEach(function (key) {
          oracledb[key] = config.options[key];
        });
      }

      function makeConnection() {
        if (config.pool === true) {
          return connectionPool(oracledb, config, swormConfig).then(pool => {
            return promisify(cb => pool.getConnection(cb));
          });
        } else if (config.pool) {
          return promisify(cb => config.pool.getConnection(cb));
        } else {
          return promisify(cb => oracledb.getConnection(config, cb));
        }
      }

      return makeConnection().then(function (connection) {
        self.connection = connection;
      });
    },

    close: function () {
      var self = this;
      if (self.connection) {
        return promisify(function (cb) {
          self.connection.release(cb);
        });
      } else {
        return Promise.resolve();
      }
    },

    insertEmpty: function(table, id) {
      return 'insert into ' + table + ' (' + id + ') values (default)';
    },

    outputIdKeys: function (idType) {
      return {
        returning_into_id: { type: idType || oracledb.NUMBER, dir: oracledb.BIND_OUT }
      };
    }
  };
};

function formatRows(resultSet) {
  var rows = resultSet.rows;
  if (!rows) {
    return rows;
  }

  var fields = resultSet.metaData.map(function (field) {
    if (/[a-z]/.test(field.name)) {
      return field.name;
    } else {
      return field.name.toLowerCase();
    }
  });

  if (fields.length > 0) {
    var length = rows.length;
    var results = new Array(length);

    for (var r = 0; r < length; r++) {
      var row = {};
      results[r] = row;
      for (var f = 0; f < fields.length; f++) {
        row[fields[f]] = rows[r][f];
      }
    }

    return results;
  } else {
    return rows;
  }
}

function replaceParameters(query) {
  return query.replace(/@([a-z_0-9]+)\b/gi, function (_, paramName) {
    return ':' + paramName;
  });
}

function parseValue(value) {
  var number = Number(value);
  if (!isNaN(number)) {
    return number;
  }
  
  if (value == 'true' || value == 'false') {
    return value == 'true';
  }

  return value;
}

function parseOptions(options) {
  var result = {};

  Object.keys(options).forEach(key => {
    result[key] = parseValue(options[key]);
  });

  return result;
}

function parseUrl(url) {
  var u = urlUtils.parse(url, true);
  var auth = u.auth? u.auth.split(':'): [];

  var options = parseOptions(u.query);

  var pool = options.pool;
  delete options.pool;

  return {
    user: auth[0],
    password: auth[1],
    connectString: u.host + u.pathname,
    pool: pool,
    options: options
  };
}

var connectionPoolCache = {};

module.exports.connectionPoolCache = connectionPoolCache;

function connectionPool(oracledb, config, swormConfig) {
  var key = JSON.stringify(config);

  var value = connectionPoolCache[key];

  if (!value) {
    value = connectionPoolCache[key] = promisify(function (cb) {
      swormDebug('creating connection pool', redactConfig(swormConfig));
      oracledb.createPool(config, cb);
    });
  }

  return value;
}
