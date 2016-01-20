//AWS Lambda Script to send S3 logs to Loggly

var aws = require('aws-sdk');
var s3  = new aws.S3({apiVersion: '2006-03-01'});

var _          = require('lodash'),
    async      = require('async'),
    request    = require('request'),
    Transform  = require('stream').Transform,
    csv        = require('csv-streamify'),
    JSONStream = require('JSONStream'),
    zlib       = require('zlib');

// Set the tag 'loggly-customer-token'to set Loggly customer token on the S3 bucket.
// Set the tag 'loggly-tag' to set Loggly tag on the S3 bucket.

LOGGLY_URL_BASE          = 'https://logs-01.loggly.com/bulk/';
BUCKET_LOGGLY_TOKEN_NAME = 'loggly-customer-token';
BUCKET_LOGGLY_TAG_NAME   = 'loggly-tag';
BUCKET_FILE_WHITE_LIST   = 'white-list';
EB_ACC_APP               = 'ebs-acc-app';
EB_ACC_PRD               = 'ebs-prd-app';

// Used if no S3 bucket tag doesn't contain customer token.
// Note: You either need to specify a cutomer token in this script or via the S3 bucket tag else an error is logged.
DEFAULT_LOGGLY_URL = null;

if (typeof LOGGLY_TOKEN !== 'undefined') {
    DEFAULT_LOGGLY_URL = LOGGLY_URL_BASE + LOGGLY_TOKEN;

    if (typeof LOGGLY_TAG !== 'undefined') {
        DEFAULT_LOGGLY_URL += '/tag/' + LOGGLY_TAG;
    }
}

if (DEFAULT_LOGGLY_URL) {
    console.log('Loading S3ToLoggly, default Loggly endpoint: ' + DEFAULT_LOGGLY_URL);
}
else {
    console.log('Loading S3ToLoggly, NO default Loggly endpoint, must be set in bucket tag ' + BUCKET_LOGGLY_TOKEN_NAME);
}

exports.handler = function (event, context) {

    console.log('Received event');
    console.log(JSON.stringify(event, null, 4));

    // Get the object from the event and show its content type
    var bucket = event.Records[0].s3.bucket.name;
    var key    = event.Records[0].s3.object.key;
    var size   = event.Records[0].s3.object.size;

    if (size == 0) {
        console.log('S3ToLoggly skipping object of size zero');
    }
    else {
        // Download the logfile from S3, and upload to loggly.
        async.waterfall(
            [
                function buckettags(next) {
                    var params = {
                        Bucket: bucket /* required */
                    };

                    s3.getBucketTagging(params, function (err, data) {
                        if (err) {
                            next(err);
                            console.log(err, err.stack);
                        } // an error occurred
                        else {
                            var s3tag = _.zipObject(_.pluck(data['TagSet'], 'Key'),
                                _.pluck(data['TagSet'], 'Value'));

                            if (s3tag[BUCKET_LOGGLY_TOKEN_NAME]) {
                                LOGGLY_URL = LOGGLY_URL_BASE + s3tag[BUCKET_LOGGLY_TOKEN_NAME];

                                if (s3tag[BUCKET_LOGGLY_TAG_NAME]) {
                                    LOGGLY_URL += '/tag/' + s3tag[BUCKET_LOGGLY_TAG_NAME];
                                }
                            }
                            else {
                                LOGGLY_URL = DEFAULT_LOGGLY_URL
                            }

                            if (s3tag[BUCKET_FILE_WHITE_LIST]) {
                                var ignoreList = s3tag[BUCKET_FILE_WHITE_LIST].split(',');
                                ignoreList.forEach(function(item){
                                    var string = item.split(':')[0],
                                        tag    = item.split(':')[1] ? item.split(':')[1] : '';
                                    if (key.indexOf(string) === -1) {
                                        next('File (' + key + ') is not in the white list.');
                                    } else {
                                        LOGGLY_URL += ',' + tag;
                                        if (key.indexOf(s3tag[EB_ACC_APP]) !== -1) {
                                            LOGGLY_URL += ',acc';
                                        } else if (key.indexOf(s3tag[EB_PRD_APP]) !== -1) {
                                            LOGGLY_URL += ',prd';
                                        } else {
                                            next('Could not determine the environment (acc or prd) for key:' + key);
                                        }
                                    }
                                });
                            }
                        }

                        if (LOGGLY_URL) next();
                        else next('No Loggly customer token. Set S3 bucket tag ' + BUCKET_LOGGLY_TOKEN_NAME)
                    });
                },

                function download(next) {
                    // Download the image from S3 into a buffer.
                    s3.getObject({
                        Bucket: bucket,
                        Key:    key
                    }, next);
                },


                function deflate(data, next) {
                    if (data.ContentType === 'application/x-gzip') {
                        zlib.gunzip(data.Body, next);
                    } else {
                        next(null, data.Body);
                    }
                },

                function upload(data, next) {
                    // Stream the logfile to loggly.
                    var bufferStream = new Transform();
                    bufferStream.push(data);
                    bufferStream.end();
                    console.log('Using Loggly endpoint: ' + LOGGLY_URL);

                    bufferStream.pipe(request.post(LOGGLY_URL))
                        .on('error', function (err) {
                            next(err)
                        })
                        .on('response', function (response) {
                            if (response.statusCode !== 200) {
                                next(err)
                            }
                        })
                        .on('end', function () {
                            next()
                        });
                }
            ],
            function (err) {
                if (err) {
                    console.error(
                        'Unable to read ' + bucket + '/' + key +
                        ' and upload to loggly' +
                        ' due to an error: ' + JSON.stringify(err, null, 4)
                    );
                } else {
                    console.log(
                        'Successfully uploaded ' + bucket + '/' + key +
                        ' to ' + LOGGLY_URL
                    );
                }
                context.done();
            }
        );
    }
};
