'use strict';

var ejs = require('ejs')
    , exec
    , dateformat = require('dateformat')
    , crypto = require('crypto')
    , async = require('async')
    , grunt = require('grunt')
    , file = grunt.file
    , log = grunt.log;

ejs.open = "{{";
ejs.close = "}}";

var cwd = __dirname;

var createFile = function (templateName, options) {
    var template = file.read(cwd + '/../template/' + templateName);
    var metadata = ejs.render(template, options);
    return metadata;
};

var md5 = function (str) {
    var hash = crypto.createHash('md5');
    return hash.update(str).digest('hex');
};

var sha1 = function (str) {
    var hash = crypto.createHash('sha1');
    return hash.update(str).digest('hex');
};

var save = function (fileContent, pomDir, fileName) {
    file.write(pomDir + '/' + fileName, fileContent);
    file.write(pomDir + '/' + fileName + '.md5', md5(fileContent));
    file.write(pomDir + '/' + fileName + '.sha1', sha1(fileContent));
};

var createAndUploadArtifacts = function (options, done) {
	var SNAPSHOT_VER = /.*SNAPSHOT$/i;
    var pomDir = options.pomDir || 'test/poms';
    var snapshot = SNAPSHOT_VER.test(options.version);

    options.parallel = options.parallel === undefined ? false : options.parallel;
    options.uploadMetadata = options.uploadMetadata === undefined ? true : options.uploadMetadata;

    if (!file.exists(pomDir)) {
        file.mkdir(pomDir);
    }

    save(createFile('project-metadata.xml', options), pomDir, 'outer.xml');
    save(createFile(snapshot ? 'latest-snapshot-metadata.xml' : 'latest-metadata.xml', options), pomDir, 'inner.xml');
    save(createFile('pom.xml', options), pomDir, 'pom.xml');

    var artifactData = file.read(options.artifact, {encoding: 'binary'});
    file.write(pomDir + '/artifact.' + options.packaging + '.md5', md5(artifactData));
    file.write(pomDir + '/artifact.' + options.packaging + '.sha1', sha1(artifactData));

    var upload = function (fileLocation, targetFile) {
        var uploadArtifact = function (cb) {
            var targetUri = options.url + '/' + targetFile, status;
            if (!options.quiet) {
                log.write('Uploading to ' + targetUri + "\n\n");
            }

            var curlOptions = [
                '--silent',
                //'--output', '/dev/stderr',
                '--write-out', '"%{http_code}"',
                '--upload-file', fileLocation,
                '--noproxy', options.noproxy ? options.noproxy : '127.0.0.1'
            ];

            if (options.auth) {
                curlOptions.push('-u');
                curlOptions.push(options.auth.username + ":" + options.auth.password);
            }

            if (options.insecure) {
                curlOptions.push('--insecure');
            }

            var execOptions = {};
            options.cwd && (execOptions.cwd = options.cwd);

            var curlCmd = ['curl', curlOptions.join(' '), targetUri].join(' ');
            
            //log.write('curlCmd: "' + curlCmd + '"\n');

            var childProcess = exec(curlCmd, execOptions, function () {
            });
            childProcess.stdout.on('data', function (data) {
                status = data;
            });
            childProcess.on('exit', function (code) {
                //log.write('code: "' + code + '", typeof(code): ' + typeof(code) + '\n');
            	//log.write('status: "' + status + '", typeof(status): ' + typeof(status) + '\n');
            		    
                if (code !== 0 || (status !== "200" && status !== "201")) {
                    cb("Status code " + status + " for " + targetUri, null);
                } else {
                    cb(null, "Ok");
                }
            });
        };
        return uploadArtifact;
    };

    var uploads = {};

    var groupIdAsPath = options.groupId.replace(/\./g, "/");
    var groupArtifactPath = groupIdAsPath + '/' + options.artifactId;
    var groupArtifactVersionPath = groupArtifactPath + '/' + options.version;

    if (options.uploadMetadata) {
        uploads[pomDir + "/outer.xml"] = groupArtifactPath + '/' + 'maven-metadata.xml';
        uploads[pomDir + "/outer.xml.sha1"] = groupArtifactPath + '/' + 'maven-metadata.xml.sha1';
        uploads[pomDir + "/outer.xml.md5"] = groupArtifactPath + '/' + 'maven-metadata.xml.md5';

        if (snapshot) {
            uploads[pomDir + "/inner.xml"] = groupArtifactVersionPath + '/' + 'maven-metadata.xml';
            uploads[pomDir + "/inner.xml.sha1"] = groupArtifactVersionPath + '/' + 'maven-metadata.xml.sha1';
            uploads[pomDir + "/inner.xml.md5"] = groupArtifactVersionPath + '/' + 'maven-metadata.xml.md5';
        }
    }

    var remoteArtifactName = options.artifactId + '-' + options.version;
    
    // Strip off the "-SNAPSHOT" on the end of the version to get the M2 base time-stamped name
    if (remoteArtifactName.length >= "-SNAPSHOT".length && remoteArtifactName.substring(remoteArtifactName.length - "-SNAPSHOT".length) === "-SNAPSHOT") {
        remoteArtifactName = remoteArtifactName.substring(0, remoteArtifactName.length - "-SNAPSHOT".length);
    }
    
    if (snapshot) {
        remoteArtifactName += "-" + options.timestamp + "-" + options.buildNumber;
    }

    if (options.uploadMetadata) {
        uploads[pomDir + "/pom.xml"] = groupArtifactVersionPath + '/' + remoteArtifactName + '.pom';
        uploads[pomDir + "/pom.xml.sha1"] = groupArtifactVersionPath + '/' + remoteArtifactName + '.pom.sha1';
        uploads[pomDir + "/pom.xml.md5"] = groupArtifactVersionPath + '/' + remoteArtifactName + '.pom.md5';
    }

    if (options.classifier) {
        remoteArtifactName = remoteArtifactName + "-" + options.classifier;
    }
    
    uploads[options.artifact] = groupArtifactVersionPath + '/' + remoteArtifactName + '.' + options.packaging;
    uploads[pomDir + "/artifact." + options.packaging + ".sha1"] = groupArtifactVersionPath + '/' + remoteArtifactName + '.' + options.packaging + '.sha1';
    uploads[pomDir + "/artifact." + options.packaging + ".md5"] = groupArtifactVersionPath + '/' + remoteArtifactName + '.' + options.packaging + '.md5';


    var fns = [];
    for (var u in uploads) {
        if (uploads.hasOwnProperty(u)) {
            fns.push(upload(u, uploads[u]));
        }
    }

    var asyncFn = options.parallel ? async.parallel : async.series;
    asyncFn(fns, function (err) {
        if (!options.quiet) {
            log.write('-------------------------------------------\n');
            if (err) {
                log.error('Artifact Upload failed\n' + String(err));
            } else {
                log.ok('Artifacts uploaded successfully');
            }
        }
        done(err ? false : true);
    });

};

module.exports = function (options, cb) {
    if (!options) {
        throw {name: "IllegalArgumentException", message: "upload artifact options required."};
    }
    exec = process.env.MOCK_NEXUS ? require('./mockexec') : require('child_process').exec;
    
    var timestamp;
    
    if (typeof(options.buildTime) === 'string') {
    	timestamp = Date.parse(options.buildTime);
    } else {
    	timestamp = new Date();
    }
    
    options.lastUpdated = dateformat(timestamp, "yyyymmddHHMMss");
    options.timestamp = dateformat(timestamp, "yyyymmdd.HHMMss");
    createAndUploadArtifacts(options, cb);
};
