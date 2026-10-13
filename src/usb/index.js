const log = require('../log')
const config = require('../config')
const queue = require('../queue')
const proc = require('../exec')

const _ = require('lodash')
const async = require('async')
const chance = require('chance').Chance()
const { exec } = require('child_process')
const fs = require('fs')
const glob = require('glob')
const path = require('path')

const settings = {
  interval: 3000,
  usedPercentWarning: 0.75,
  usedPercentDanger: 0.9,
  isProduction: process.env.NODE_ENV === 'production',
  isMac: process.platform === 'darwin',
  usbDir: process.env.NODE_ENV === 'production' ? '/mnt/usb' : path.join(__dirname, '../../mnt/usb'),
  ramDir: process.env.NODE_ENV === 'production' ? '/mnt/ram' : path.join(__dirname, '../../mnt/ram'),
  debugFolder: false
}

let isMounted
let lastSpace
let hwVersion

exports.start = (cb) => {
  cb = cb || function () {}

  const startTimestamp = Math.round(+new Date() / 1000)
  const files = []

  let isNotify = config.get('emailRecipients').length || config.get('telegramRecipients').length
  let notifications = isNotify ? config.get('notifications') : []

  async.series([
    (cb) => {
      glob(`${settings.ramDir}/*`, (err, tempFiles) => {
        if (err) {
          return cb(err)
        }

        async.eachSeries(tempFiles, (tempFile, cb) => {
          fs.rm(tempFile, () => cb())
        }, cb)
      })
    },
    (cb) => {
      getSpace((err, space) => {
        if (!err) {
          if (space.status !== 'success' && notifications.includes('lowStorage')) {
            const carName = config.get('carName')
            const text = `${carName} storage ${space.status}: ${space.usedPercentFormatted}% used (${space.used} of ${space.total} GB)`
            queue.notify.push({
              id: 'storage',
              subject: text,
              text,
              html: text
            })
          }
        }

        cb(err)
      })
    },
    (cb) => {
      async.forever((next) => {
        const dashcamDuration = config.get('dashcamDuration')
        const isDashcam = config.get('dashcam') && dashcamDuration
        const sentryDuration = config.get('sentryDuration')
        const isSentry = config.get('sentry') && sentryDuration
        const sentryIgnoreAngles = config.get('sentryIgnoreAngles')
        const isStream = config.get('stream') || config.get('streamCopy')
        const streamAngles = config.get('streamAngles')

        isNotify = config.get('emailRecipients').length || config.get('telegramRecipients').length
        notifications = isNotify ? config.get('notifications') : []

        let isSpaceChanged

        async.series([
          mount,
          (cb) => {
            glob(`${settings.usbDir}/TeslaCam/RecentClips/*.mp4`, (err, currentFiles) => {
              if (err) {
                return cb(err)
              }

              async.eachSeries(currentFiles, (currentFile, cb) => {
                const fileParts = currentFile.split(/[\\/]/)
                const filename = _.last(fileParts)
                const angle = getAngle(filename)
                const folder = filename.split(`-${angle}`)[0]
                const dateParts = folder.split('_')
                const timestamp = Math.round(+new Date(`${dateParts[0]} ${dateParts[1].replace(/-/g, ':')}`) / 1000)
                if (timestamp < startTimestamp || _.find(files, { type: 'stream', file: currentFile })) {
                  return cb()
                }

                files.push({
                  type: 'stream',
                  file: currentFile
                })

                async.series([
                  (cb) => {
                    if (hwVersion) {
                      return cb()
                    }

                    proc.run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', currentFile], (err, stdout) => {
                      hwVersion = stdout.includes('1448x938') || stdout.includes('2896x1876') ? 4 : 3
                      log.debug(`[usb] determined hwVersion: ${hwVersion}`)
                      cb()
                    })
                  },
                  (cb) => {
                    if (!isStream || !streamAngles.includes(angle)) {
                      return cb()
                    }

                    copyTemp(currentFile, (err, tempFile) => {
                      if (!err) {
                        queue.stream.push({
                          id: currentFile,
                          folder,
                          tempFile,
                          angle,
                          timestamp,
                          hwVersion
                        })
                      }

                      cb(err)
                    })
                  }
                ], cb)
              }, cb)
            })
          },
          (cb) => {
            glob(`${settings.usbDir}/TeslaCam/**/event.json`, (err, currentFiles) => {
              if (err) {
                return cb(err)
              }

              async.eachSeries(currentFiles, (currentFile, cb) => {
                const fileParts = currentFile.split(/[\\/]/)
                const folder = _.nth(fileParts, -2)
                const dateParts = folder.split('_')
                const timestamp = Math.round(+new Date(`${dateParts[0]} ${dateParts[1].replace(/-/g, ':')}`) / 1000)
                const eventType = fileParts.includes('SentryClips') ? 'sentry' : fileParts.includes('TrackClips') ? 'track' : 'dashcam'
                if ((timestamp < startTimestamp && (!settings.debugFolder || folder !== settings.debugFolder)) || _.find(files, { type: eventType, file: currentFile })) {
                  return cb()
                }

                files.push({
                  type: eventType,
                  file: currentFile
                })

                if ((eventType !== 'sentry' && isDashcam) || (eventType === 'sentry' && isSentry)) {
                  fs.readFile(currentFile, (err, eventContents) => {
                    if (err) {
                      return cb(err)
                    }

                    let event

                    try {
                      event = JSON.parse(eventContents)
                      event.datetime = event.timestamp.replace('T', ' ')
                      event.timestamp = Math.round(+new Date(event.timestamp) / 1000)
                      event.type = eventType
                    } catch (err) {
                      return cb(err)
                    }

                    event.angle = ['3', '5'].includes(event.camera) ? 'left' : ['4', '6'].includes(event.camera) ? 'right' : event.camera === '7' ? 'back' : 'front'

                    if (eventType === 'sentry' && sentryIgnoreAngles.includes(event.angle)) {
                      return cb()
                    }

                    const archiveDuration = event.type === 'sentry' ? sentryDuration : dashcamDuration
                    const startEventTimestamp = event.timestamp - (event.type === 'sentry' ? Math.round(archiveDuration * 0.4) : archiveDuration)
                    const endEventTimestamp = event.timestamp + (event.type === 'sentry' ? Math.round(archiveDuration * 0.6) : 10)

                    const tempFiles = []

                    glob(`${path.join(currentFile, '..')}/*.mp4`, (err, videoFiles) => {
                      if (err) {
                        return cb(err)
                      }

                      async.eachSeries(videoFiles.reverse(), (videoFile, cb) => {
                        const fileParts = videoFile.split(/[\\/]/)
                        const filename = _.last(fileParts)
                        const angle = getAngle(filename)
                        const dateParts = filename.split(`-${angle}`)[0].split('_')
                        const timestamp = Math.round(+new Date(`${dateParts[0]} ${dateParts[1].replace(/-/g, ':')}`) / 1000)

                        if (timestamp + 60 < startEventTimestamp || timestamp > endEventTimestamp) {
                          return cb()
                        }

                        let fileDuration

                        async.series([
                          (cb) => {
                            proc.run('ffprobe', ['-hide_banner', '-v', 'quiet', '-show_entries', 'format=duration', '-i', videoFile], (err, stdout) => {
                              if (!err && stdout.includes('duration=')) {
                                fileDuration = Math.ceil(stdout.split('duration=')[1].split('\n')[0])
                              }

                              cb(err)
                            })
                          },
                          (cb) => {
                            if (notifications.includes('earlyWarningVideo') && angle === event.angle && timestamp < event.timestamp && timestamp + fileDuration >= event.timestamp) {
                              copyTemp(videoFile, (err, tempFile) => {
                                if (!err) {
                                  const start = event.timestamp - timestamp

                                  queue.early.push({
                                    id: currentFile,
                                    hwVersion,
                                    folder,
                                    event,
                                    timestamp,
                                    start,
                                    file: tempFile
                                  })
                                }

                                cb(err)
                              })
                            } else {
                              cb()
                            }
                          },
                          (cb) => {
                            if (timestamp + fileDuration > startEventTimestamp && timestamp <= endEventTimestamp) {
                              copyTemp(videoFile, (err, tempFile) => {
                                if (!err) {
                                  const start = timestamp > startEventTimestamp ? 0 : startEventTimestamp - timestamp
                                  const duration = timestamp + fileDuration > endEventTimestamp ? endEventTimestamp - timestamp : fileDuration - start

                                  tempFiles.push({
                                    file: tempFile,
                                    angle,
                                    timestamp,
                                    start,
                                    duration
                                  })
                                }

                                cb(err)
                              })
                            } else {
                              cb()
                            }
                          }
                        ], cb)
                      }, (err) => {
                        if (err) {
                          return cb(err)
                        }

                        queue.archive.push({
                          id: currentFile,
                          hwVersion,
                          folder,
                          event,
                          tempFiles
                        })

                        if (notifications.includes('earlyWarning')) {
                          queue.notify.push({
                            id: `${currentFile} (earlyWarning)`,
                            event
                          })
                        }

                        isSpaceChanged = true
                        cb()
                      })
                    })
                  })
                } else {
                  cb()
                }
              }, (err) => {
                err ? cb(err) : isSpaceChanged ? getSpace(cb) : cb()
              })
            })
          }
        ], (err) => {
          umount(() => {
            if (err) {
              log.warn(`[usb] failed: ${err}`)
            }

            setTimeout(next, settings.interval)
          })
        })
      })

      cb()
    }
  ], cb)
}

const copyTemp = (source, cb) => {
  cb = cb || function () {}

  const destination = path.join(settings.ramDir, `${chance.hash()}.mp4`)
  fs.copyFile(source, destination, (err) => {
    cb(err, destination)
  })
}

const mount = (cb) => {
  cb = cb || function () {}

  if (!settings.isProduction || isMounted) {
    return cb()
  }

  exec(`mount ${settings.usbDir}`, (err) => {
    if (err) {
      log.debug(`[usb] mount failed: ${err}`)
    }

    isMounted = true
    cb()
  })
}

const umount = (cb) => {
  cb = cb || function () {}

  if (!settings.isProduction || !isMounted) {
    return cb()
  }

  exec(`umount ${settings.usbDir}`, (err) => {
    if (err) {
      log.debug(`[usb] umount failed: ${err}`)
    }

    isMounted = false
    cb()
  })
}

const getAngle = (filename) => {
  return filename.includes('-front') ? 'front' : filename.includes('-right') ? 'right' : filename.includes('-back') ? 'back' : filename.includes('-left') ? 'left' : undefined
}

const getSpace = (cb) => {
  cb = cb || function () {}

  mount(() => {
    exec(`df ${settings.isMac ? '-g' : '-B G'} ${settings.usbDir}`, (err, space) => {
      umount(() => {
        if (!err) {
          space = space.split(/[\r\n]+/)[1].split(/\s+/)
          space = {
            total: Math.round(parseFloat(space[1])),
            used: Math.round(parseFloat(space[2])),
            available: Math.round(parseFloat(space[3]))
          }

          space.usedPercent = space.used / space.total
          space.usedPercentFormatted = Math.ceil(space.usedPercent * 100)
          space.status = space.usedPercent > settings.usedPercentDanger ? 'danger' : space.usedPercent > settings.usedPercentWarning ? 'warning' : 'success'
          lastSpace = space
        }

        cb(err, space)
      })
    })
  })
}

exports.umount = umount

exports.getLastSpace = () => {
  return lastSpace || {}
}
