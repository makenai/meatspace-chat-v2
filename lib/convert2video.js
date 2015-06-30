'use strict';

var fs = require('fs');
var child = require('child_process');

var uuid = require('uuid');
var dataURIBuffer = require('data-uri-to-buffer');
var glob = require('glob');
var async = require('async');
var readimage = require('readimage');
var writepng = require('writepng');
var glitch = require('./glitch');

var TMP_DIR = __dirname + '/../tmp/';
var IMAGE_FORMAT = 'png';

exports.transform = function (mediaArr, message, next) {
  // write images to tmp files
  var mediaId = uuid.v4();
  var count = 0;

  var deleteFiles = function () {
    glob(TMP_DIR + mediaId + '*', function (err, files) {
      if (err) {
        console.log('glob error: ', err);
        return;
      }

      files.forEach(function (file) {
        fs.unlink(file, function (err) {
          if (err) {
            console.log('error unlinking ' + file + ':', err);
          }
        });
      });
    });
  };

  var done = function(err, videos) {
    next(err, videos);
    deleteFiles();
  };

  var writeVideo = function () {
    var types = [{
      format: 'webm',
      ffmpegArgs: '" -filter:v "setpts=2.5*PTS" -vcodec libvpx -an "'
    }, {
      format: 'mp4',
      ffmpegArgs: '" -filter:v "setpts=2.5*PTS" -c:v libx264 -an -pix_fmt yuv420p "'
    }];

    async.map(types, function (type, callback) {
      var video = new Buffer(0);
      var command = [
        'ffmpeg -i "',
        TMP_DIR + mediaId + '-%d.' + IMAGE_FORMAT,
        type.ffmpegArgs,
        TMP_DIR + mediaId + '.' + type.format,
        '"'
      ].join('');

      child.exec(command, { timeout: 3000 }, function (err, stdout, stderr) {
        if (err) {
          return callback(err);
        }

        var filename = TMP_DIR + mediaId + '.' + type.format;
        var readStream = fs.createReadStream(filename);

        readStream.on('data', function (chunk) {
          video = Buffer.concat([video, chunk]);
        });

        readStream.on('error', function (err) {
          callback(err);
        });

        readStream.on('end', function () {
          var base64 = video.toString('base64');
          callback(null, {
            format: type.format,
            data: 'data:video/' + type.format + ';base64,' + base64
          });
        });
      });
    }, function (err, results) {
      var videos = {};

      if (err) {
        done(err);
      } else {
        results.forEach(function (result) {
          videos[result.format] = result.data;
        });
        done(null, videos);
      }
    });
  };

  var fileFinished = function() {
    count++;

    if (count === mediaArr.length) {
      writeVideo();
    }
  };

  var frames = new Array(mediaArr.length);

  for (var i = 0; i < mediaArr.length; i ++) {
    var frame = mediaArr[i];
    if (frame.length > 30000 * 4 / 3) {
      return done(new Error('File too large'));
    }

    readimage(dataURIBuffer(frame), function (err, image) {
      if (err) {
        throw err;
      }

      frames[i] = image;

      if (i === mediaArr.length - 1) {
        glitch(frames, message);
        writeFrames(frames);
      }
    });
  }

  function writeFile(frame, count) {
    writepng(frame, function (err, buffer) {
      var writeStream = fs.createWriteStream(TMP_DIR + mediaId + '-' + count + '.' + IMAGE_FORMAT);
      console.log('writing file ', TMP_DIR + mediaId + '-' + count)
      writeStream
        .on('error', done)
        .end(buffer, fileFinished);
    });
  }

  function writeFrames(framesArr) {
    for (var x = 0; x < framesArr.length; x ++) {
      writeFile(framesArr[x], x);
    }
  }
};
