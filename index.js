
var util = require('util')
var EventEmitter = require('events').EventEmitter
var typeforce = require('typeforce')
var debug = require('debug')('sendy-axolotl')
var connect = require('sendy').connect
var Wire = require('@tradle/wire')
var noop = function () {}

function Client (opts) {
  var self = this

  typeforce({
    client: 'Object',
    key: 'Object',
    theirPubKey: 'Object'
  }, opts)

  EventEmitter.call(this)

  this._client = opts.client
  connect(this, this._client)

  this._key = opts.key
  this._theirPubKey = opts.theirPubKey
  this._debugId = new Buffer(opts.key.publicKey).toString('hex').slice(0, 10)
  this._deliveryCallbacks = []
  this._queue = []
  this._queuedChunks = 0
  this._setupWire()

  this._client.on('receive', function (msg) {
    if (self._wire) self._wire.write(msg)
  })
}

util.inherits(Client, EventEmitter)
exports = module.exports = Client

Client.prototype._debug = function () {
  var args = Array.prototype.slice.call(arguments)
  args.unshift(this._debugId)
  return debug.apply(null, args)
}

Client.prototype._setupWire = function () {
  const self = this
  const wire = this._wire = new Wire({
    identity: this._key,
    theirIdentity: this._theirPubKey
  })

  wire.on('data', function (msg) {
    if (self._destroyed) return

    // self._debug('sending', msg)
    self._deliveryCallbacks.push({
      count: ++self._queuedChunks,
      callback: null
    })

    self._debug('sending...')
    self._client.send(msg, function (err) {
      // more expensive, but simpler
      if (err) return self.destroy()

      self._queuedChunks--
      self._deliveryCallbacks.forEach(function (item) {
        item.count--
      })

      var callNow = self._deliveryCallbacks.filter(function (item) {
        return item.count === 0
      })

      self._deliveryCallbacks = self._deliveryCallbacks.filter(function (item) {
        return item.count !== 0
      })

      callNow.forEach(function (item) {
        if (item.callback) item.callback()
      })
    })
  })

  wire.on('request', function (req) {
    if (self._destroyed) return

    self.emit('request', req)
  })

  wire.on('message', function (msg) {
    if (self._destroyed) return

    self._debug('received message')
    self.emit('receive', msg)
  })

  wire.on('error', function (err) {
    if (self._destroyed) return

    self.destroy()

    // self._debug('resetting due to OTR error: ' + err)
    // self._resetAndResend()
  })

  this._processQueue()
}

Client.prototype.send = function (msg, ondelivered) {
  var self = this
  if (this._destroyed) throw new Error('destroyed')

  if (this._cancelingPending) {
    return process.nextTick(function () {
      self.send(msg, ondelivered)
    })
  }

  this._debug('queueing msg')
  this._queue.push(arguments)
  if (typeof msg === 'string') {
    // assume utf8
    msg = new Buffer(msg)
  }

  this._processQueue()
}

// Client.prototype._resetAndResend = function () {
//   var queue = this._queue.slice()
//   this.reset()
//   queue.forEach(function (args) {
//     this.send.apply(this, args)
//   }, this)
// }

Client.prototype._processQueue = function () {
  var self = this
  if (this._destroyed || !this._queue.length) return

  var next = this._queue[0]
  var msg = next[0]
  var ondelivered = next[1] || noop
  this._wire.send(msg, function (err) {
    if (self._destroyed) return
    if (err) return self.emit('error', err)

    // last 'data' event for this message
    // has just been emitted
    //
    // NOTE: this doesn't work if a session needs to be re-established
    // for some reason during the process of getting this message through
    // so it's better to not rely on this and number messages instead
    self._deliveryCallbacks[self._deliveryCallbacks.length - 1].callback = function (err) {
      self._debug('delivered msg')
      self._queue.shift()
      ondelivered(err)
    }
  })
}

Client.prototype.destroy = function () {
  var self = this
  if (this._destroyed) return

  this._debug('destroying')
  this._destroyed = true
  this._wire.end()
  this._client.destroy()
  this.emit('destroy')
}
