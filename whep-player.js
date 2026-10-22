/*
 * TabCast Relay — WHEP (WebRTC-HTTP Egress Protocol) player core.
 *
 * The signaling half (buildWhepRequest / whepPlay) is dependency-injected
 * and unit-testable in Node; the playback half (WhepPlayer) wires it to a
 * real RTCPeerConnection + <video> element in the browser.
 *
 * Exposes `TabCastWhep` globally; module.exports under Node.
 */
(function (root) {
  'use strict';

  function buildWhepHeaders(token) {
    var headers = { 'Content-Type': 'application/sdp' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return headers;
  }

  function resolveResourceUrl(endpoint, locationHeader) {
    if (!locationHeader) return null;
    try {
      return new URL(locationHeader, endpoint).toString();
    } catch (e) {
      return locationHeader;
    }
  }

  /**
   * Perform the WHEP SDP exchange: POST our recvonly offer, get the
   * server's answer. Returns { answerSdp, resourceUrl }.
   */
  async function whepPlay(opts) {
    var fetchImpl = opts.fetchImpl || root.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
    var res = await fetchImpl(opts.endpoint, {
      method: 'POST',
      headers: buildWhepHeaders(opts.token),
      body: opts.offerSdp,
    });
    if (res.status !== 201) {
      var text = '';
      try { text = await res.text(); } catch (e) { /* ignore */ }
      throw new Error('WHEP play failed: HTTP ' + res.status + (text ? ' — ' + text.slice(0, 200) : ''));
    }
    var answerSdp = await res.text();
    var location = res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('location')
      : null;
    return { answerSdp: answerSdp, resourceUrl: resolveResourceUrl(opts.endpoint, location) };
  }

  async function whepDelete(opts) {
    if (!opts.resourceUrl) return false;
    var fetchImpl = opts.fetchImpl || root.fetch;
    if (typeof fetchImpl !== 'function') return false;
    try {
      var res = await fetchImpl(opts.resourceUrl, {
        method: 'DELETE',
        headers: opts.token ? { Authorization: 'Bearer ' + opts.token } : {},
      });
      return res.status === 200 || res.status === 204 || res.status === 404;
    } catch (e) {
      return false;
    }
  }

  /**
   * Browser player: attach a WHEP stream to a <video> element.
   * events: callback (name, detail) with names: 'signaling', 'connected',
   * 'playing', 'failed', 'ended'.
   */
  function WhepPlayer(videoElement, events) {
    this.video = videoElement;
    this.events = typeof events === 'function' ? events : function () {};
    this.pc = null;
    this.resourceUrl = null;
    this.endpoint = null;
    this.token = '';
  }

  WhepPlayer.prototype.start = async function (endpoint, token) {
    await this.stop();
    this.endpoint = endpoint;
    this.token = token || '';
    this.events('signaling', endpoint);

    var pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    var stream = new MediaStream();
    pc.addEventListener('track', (ev) => {
      stream.addTrack(ev.track);
      if (this.video.srcObject !== stream) this.video.srcObject = stream;
    });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') this.events('connected', endpoint);
      if (pc.connectionState === 'failed') this.events('failed', 'Peer connection failed');
      if (pc.connectionState === 'closed') this.events('ended', 'Peer connection closed');
    });

    var offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // Non-trickle WHEP: wait for gathering to complete before sending.
    await waitForIceGatheringComplete(pc, 3000);

    var result = await whepPlay({ endpoint: endpoint, offerSdp: pc.localDescription.sdp, token: this.token });
    this.resourceUrl = result.resourceUrl;
    await pc.setRemoteDescription({ type: 'answer', sdp: result.answerSdp });

    try {
      await this.video.play();
      this.events('playing', endpoint);
    } catch (e) {
      // Autoplay policies may require a user gesture; the page shows a
      // play button in that case. The stream itself is connected.
      this.events('connected', 'autoplay blocked: ' + e.message);
    }
  };

  WhepPlayer.prototype.stop = async function () {
    if (this.resourceUrl) {
      await whepDelete({ resourceUrl: this.resourceUrl, token: this.token });
      this.resourceUrl = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch (e) { /* ignore */ }
      this.pc = null;
    }
    if (this.video) this.video.srcObject = null;
  };

  function waitForIceGatheringComplete(pc, timeoutMs) {
    var timeout = typeof timeoutMs === 'number' ? timeoutMs : 3000;
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        cleanup();
        reject(new Error('ICE gathering timed out after ' + timeout + 'ms'));
      }, timeout);
      function onChange() {
        if (pc.iceGatheringState === 'complete') {
          cleanup();
          resolve();
        }
      }
      function cleanup() {
        clearTimeout(timer);
        if (typeof pc.removeEventListener === 'function') {
          pc.removeEventListener('icegatheringstatechange', onChange);
        }
      }
      pc.addEventListener('icegatheringstatechange', onChange);
    });
  }

  var api = {
    buildWhepHeaders: buildWhepHeaders,
    resolveResourceUrl: resolveResourceUrl,
    whepPlay: whepPlay,
    whepDelete: whepDelete,
    waitForIceGatheringComplete: waitForIceGatheringComplete,
    WhepPlayer: WhepPlayer,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TabCastWhep = api;
})(typeof self !== 'undefined' ? self : globalThis);
