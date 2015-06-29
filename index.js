'use strict';

var Hapi = require('hapi');
var nconf = require('nconf');
var SocketIO = require('socket.io');
var crypto = require('crypto');

var services = require('./lib/services');

nconf.argv().env().file({ file: 'local.json' });

var users = 0;

var server = new Hapi.Server();

var user = {
  username: nconf.get('auth-username'),
  password: nconf.get('auth-password')
};

server.connection({
  host: nconf.get('domain'),
  port: nconf.get('port')
});

server.views({
  engines: {
    jade: require('jade')
  },
  isCached: process.env.node === 'production',
  path: __dirname + '/views',
  compileOptions: {
    pretty: true
  }
});

var login = function (request, reply) {
  if (request.auth.isAuthenticated) {
    return reply.redirect('/chat');
  }

  var message = '';
  var account = null;

  if (request.method === 'post') {
    if (!request.payload.username ||
        !request.payload.password) {
      message = 'Missing username or password';
    } else {
      if (request.payload.username !== user.username &&
          request.payload.password !== user.password) {
        message = 'Invalid username or password';
      }
    }
  }

  if (request.method === 'get' || message) {
    return reply('<html><head><title>Login page</title></head><body>'
        + (message ? '<h3>' + message + '</h3><br/>' : '')
        + '<form method="post" action="/login">'
        + 'Username: <input type="text" name="username"><br>'
        + 'Password: <input type="password" name="password"><br/>'
        + '<input type="submit" value="Login"></form></body></html>');
  }

  request.auth.session.set(user);
  return reply.redirect('/chat');
};

var logout = function (request, reply) {
  request.auth.session.clear();
  return reply.redirect('/login');
};

server.register(require('hapi-auth-cookie'), function (err) {
  server.auth.strategy('session', 'cookie', {
    password: nconf.get('auth-password'),
    cookie: nconf.get('auth-cookie'),
    redirectTo: '/login',
    isSecure: false
  });
});

var routes = [
  {
    method: 'GET',
    path: '/',
    config: {
      handler: login,
      auth: 'session'
    }
  },
  {
    method: 'GET',
    path: '/chat',
    config: {
      handler: home,
      auth: 'session'
    }
  },
  {
    method: ['GET', 'POST'],
    path: '/login',
    config: {
      handler: login,
      auth: {
        mode: 'try',
        strategy: 'session'
      },
      plugins: {
        'hapi-auth-cookie': {
          redirectTo: false
        }
      }
    }
  },
  {
    method: 'GET',
    path: '/logout',
    config: {
      handler: logout,
      auth: 'session'
    }
  }
];

server.route(routes);

server.route({
  path: '/{path*}',
  method: "GET",
  config: {
    handler: {
      directory: {
        path: './dist',
        listing: false,
        index: false
      }
    }
  }
});

server.start(function () {
  var io = SocketIO.listen(server.listener);

  var getUserId = function (fingerprint, ip) {
    return crypto.createHash('md5').update(fingerprint + ip).digest('hex');
  };

  var disconnectHandler = function() {
    users--;
    if (users < 0) {
      users = 0;
    }
    io.emit('active', users);
  };

  io.on('connection', function (socket) {
    socket.on('disconnect', disconnectHandler);

    users++;
    io.emit('active', users);

    socket.on('join', function (format) {
      socket.join(format);
      services.recent(socket, format);
    });

    var ip = socket.handshake.address;
    if (socket.handshake.headers['x-forwarded-for']) {
      ip = socket.handshake.headers['x-forwarded-for'].split(/ *, */)[0];
    }

    socket.on('message', function (data) {
      if (typeof data === 'string') {
        // Handle legacy clients that nonsensically double-JSON-encoded
        // TODO(tec27): remove this code when we're sure no clients are doing this any more
        if (data.length > 1 * 1024 * 1024 /* 1MB */) {
          console.log('Oversized message received: ' + (data.length / (1024 * 1024)) + 'MB');
          return socket.emit('messageack', 'Message too large');
        }

        try {
          data = JSON.parse(data);
        } catch (err) {
          console.log('Received malformed JSON');
          return socket.emit('messageack', 'Malformed JSON');
        }
      }

      var ackData = { key: data.key };
      if (!data.fingerprint || data.fingerprint.length > 32) {
        return socket.emit('messageack', 'Invalid fingerprint', ackData);
      }

      var userId = getUserId(data.fingerprint, ip);
      ackData.userId = userId;
      var payload = {
        message: data.message,
        media: data.media,
        fingerprint: userId
      };

      services.addMessage(payload, function (err, chat) {
        if (err) {
          console.log('error ', err);
          return socket.emit('messageack', 'Error adding message', ackData);
        }

        socket.emit('messageack', null, ackData);
        var videoData = chat.media;
        var formats = ['webm', 'mp4'];

        formats.forEach(function (format) {
          chat.media = videoData[format];
          io.sockets.in(format).emit('message', chat);
        });
      });
    });
  });
});

function home(request, reply) {
  if (!request.auth.isAuthenticated) {
    return reply.redirect('/login');
  }
  reply.view('index', {
    analytics: nconf.get('analytics'),
    session: request.auth.isAuthenticated
  });
}
