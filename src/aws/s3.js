const log = require("../log");

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3')
const { Upload } = require('@aws-sdk/lib-storage')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')

const settings = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_DEFAULT_REGION,
  bucket: process.env.AWS_S3_BUCKET,
  endpoint: process.env.S3_ENDPOINT,
};

let client;

exports.start = (cb) => {
  cb = cb || function () {};

  if (
    !settings.accessKeyId ||
    !settings.secretAccessKey ||
    !settings.region ||
    !settings.bucket
  ) {
    log.warn(
      `[aws/s3] client disabled because AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION and/or AWS_S3_BUCKET is missing`
    );
    return cb();
  }

  // If endpoint does not exist is AWS else is a Compatible S3 Bucket
  if (!settings.endpoint) {
    //This is for AWS S3 bucket
    client = new S3Client({
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
      region: settings.region,
      maxAttempts: 1,
    });
  } else {
    // This is where an S3-compatible endpoint is used
    log.info(`[custom/s3] client will use your own S3 compatible cloud provider...`);
    client = new S3Client({
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
      region: settings.region,
      maxAttempts: 1,
      endpoint: settings.endpoint, // custom S3 endpoint
      forcePathStyle: true, // Use path-style addressing
    });
  }
  cb();
};

exports.putObject = (
  Key,
  Body,
  ContentType = "application/octet-stream",
  cb
) => {
  cb = cb || function () {};

  if (!client) {
    return cb();
  }

  const params = {
    Bucket: settings.bucket,
    Key,
    Body,
    ContentType,
  };

  const upload = new Upload({
    client,
    params,
  })

  upload.on('httpUploadProgress', (progress) => {
    log.debug(`[aws/s3] ${Key} progress: ${((progress.loaded / progress.total) * 100).toFixed(2)}%`)
  })

  upload.done()
  .then((data) => {
    cb(null, data)
  })
  .catch((err) => {
    cb(err)
  })
}

exports.getSignedUrl = (Key, expiresIn, cb) => {
  cb = cb || function () {};

  if (!client) {
    return cb();
  }

  const params = {
    Bucket: settings.bucket,
    Key,
  };

  getSignedUrl(client, new GetObjectCommand(params), { expiresIn })
    .then((data) => cb(null, data))
    .catch((err) => cb(err));
};
