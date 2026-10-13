const _ = require('lodash')
const JSONdb = require('simple-json-db')
const path = require('path')

const settings = {
  carName: 'My Tesla',
  logLevel: 'warn',
  emailRecipients: [],
  telegramRecipients: [],
  notifications: ['lowStorage', 'earlyWarningVideo'],
  dashcam: true,
  dashcamQuality: 'medium',
  dashcamDuration: 30,
  sentry: true,
  sentryCinematic: false,
  sentryQuality: 'high',
  sentryDuration: 30,
  sentryIgnoreAngles: [],
  stream: false,
  streamCopy: false,
  streamQuality: 'high',
  streamAngles: ['front']
}

let db

// the car name ends up inside ffmpeg filters, S3 keys and Telegram messages, so only keep letters, numbers, spaces and . ( ) -
const sanitizeCarName = (value) => {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/[^\p{L}\p{N} .()-]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '')
    .slice(0, 40) || settings.carName
}

exports.sanitizeCarName = sanitizeCarName

exports.start = (cb) => {
  cb = cb || function () {}

  db = new JSONdb(path.join(__dirname, '../../config.json'))

  // if never set, use defaults
  _.forEach(settings, (value, key) => {
    if (!db.has(key)) {
      set(key, value)
    }
  })

  set('sentryIgnoreAngles', settings.sentryIgnoreAngles)
  set('carName', db.get('carName'))

  cb()
}
exports.get = (key) => {
  return db.get(key)
}


const set = (key, value) => {
  switch (key) {
    case 'carName':
      value = sanitizeCarName(value)
      break

    case 'logLevel':
      value = ['debug', 'info', 'warn', 'error', 'fatal'].includes(value) ? value : settings[key]
      break

    case 'emailRecipients':
    case 'telegramRecipients':
    case 'streamAngles':
    case 'sentryIgnoreAngles':
      value = _.compact(_.isArray(value) ? value : _.split((value || '').toLowerCase(), /[\r\n, ]+/))
      if (!value.length) {
        value = settings[key]
      }
      break

    case 'notifications':
      value = _.compact(_.isArray(value) ? value : _.split(value, /[\r\n, ]+/))
      break

    case 'sentryQuality':
    case 'dashcamQuality':
    case 'streamQuality':
      value = ['highest', 'high', 'medium', 'low', 'lowest'].includes(value) ? value : settings[key]
      break

    case 'dashcam':
    case 'sentry':
    case 'sentryCinematic':
    case 'stream':
    case 'streamCopy':
      value = !!value
      break

    case 'sentryDuration':
    case 'dashcamDuration':
      value = Number(value) || settings[key]
      break

    default:
      value = value || settings[key]
  }

  return db.set(key, value)
}

exports.set = set
