/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * Initial implementation of EME
 *
 * Implemented by Google Chrome prior to v36
 *
 * @implements ProtectionModel
 * @class
 */
import ProtectionModel from './ProtectionModel.js';
import ProtectionExtensions from '../extensions/ProtectionExtensions.js';
import NeedKey from '../vo/protection/NeedKey.js';
import KeyError from '../vo/protection/KeyError.js';
import KeyMessage from '../vo/protection/KeyMessage.js';
import KeySystemConfiguration from '../vo/protection/KeySystemConfiguration.js';
import KeySystemAccess from '../vo/protection/KeySystemAccess.js';
import SessionToken from '../vo/protection/SessionToken.js';
import EventBus from '../utils/EventBus.js';
import Events from '../Events.js';
import ErrorHandler from '../ErrorHandler.js';

let ProtectionModel_01b = function () {

    var videoElement = null,
        protectionExt = ProtectionExtensions.getInstance(),
        errHandler = ErrorHandler.getInstance(),

        // API names object selected for this user agent
        api = null,

        // With this version of the EME APIs, sessionIDs are not assigned to
        // sessions until the first key message is received.  We are assuming
        // that in the case of multiple sessions, key messages will be received
        // in the order that generateKeyRequest() is called.

        // Holding spot for newly-created sessions until we determine whether or
        // not the CDM supports sessionIDs
        pendingSessions = [],

        // List of sessions that have been initialized.  Only the first position will
        // be used in the case that the CDM does not support sessionIDs
        sessions = [],

        // Not all CDMs support the notion of sessionIDs.  Without sessionIDs
        // there is no way for us to differentiate between sessions, therefore
        // we must only allow a single session.  Once we receive the first key
        // message we can set this flag to determine if more sessions are allowed
        moreSessionsAllowed,

        // This is our main event handler for all desired HTMLMediaElement events
        // related to EME.  These events are translated into our API-independent
        // versions of the same events
        createEventHandler = function() {
            var self = this;
            return {
                handleEvent: function(event) {
                    var sessionToken = null;
                    switch (event.type) {

                        case api.needkey:
                            var initData = ArrayBuffer.isView(event.initData) ? event.initData.buffer : event.initData;
                            EventBus.trigger(Events.NEED_KEY, {key:new NeedKey(initData, "cenc")});
                            break;

                        case api.keyerror:
                            sessionToken = findSessionByID(sessions, event.sessionId);
                            if (!sessionToken) {
                                sessionToken = findSessionByID(pendingSessions, event.sessionId);
                            }

                            if (sessionToken) {
                                var msg = "";
                                switch (event.errorCode.code) {
                                    case 1:
                                        msg += "MEDIA_KEYERR_UNKNOWN - An unspecified error occurred. This value is used for errors that don't match any of the other codes.";
                                        break;
                                    case 2:
                                        msg += "MEDIA_KEYERR_CLIENT - The Key System could not be installed or updated.";
                                        break;
                                    case 3:
                                        msg += "MEDIA_KEYERR_SERVICE - The message passed into update indicated an error from the license service.";
                                        break;
                                    case 4:
                                        msg += "MEDIA_KEYERR_OUTPUT - There is no available output device with the required characteristics for the content protection system.";
                                        break;
                                    case 5:
                                        msg += "MEDIA_KEYERR_HARDWARECHANGE - A hardware configuration change caused a content protection error.";
                                        break;
                                    case 6:
                                        msg += "MEDIA_KEYERR_DOMAIN - An error occurred in a multi-device domain licensing configuration. The most common error is a failure to join the domain.";
                                        break;
                                }
                                msg += "  System Code = " + event.systemCode;
                                // TODO: Build error string based on key error
                                EventBus.trigger(Events.KEY_ERROR, {data:new KeyError(sessionToken, msg)});
                            } else {
                                self.log("No session token found for key error");
                            }
                            break;

                        case api.keyadded:
                            sessionToken = findSessionByID(sessions, event.sessionId);
                            if (!sessionToken) {
                                sessionToken = findSessionByID(pendingSessions, event.sessionId);
                            }

                            if (sessionToken) {
                                self.log("DRM: Key added.");
                                EventBus.trigger(Events.KEY_ADDED, {data:sessionToken});//TODO not sure anything is using sessionToken? why there?
                            } else {
                                self.log("No session token found for key added");
                            }
                            break;

                        case api.keymessage:

                            // If this CDM does not support session IDs, we will be limited
                            // to a single session
                            moreSessionsAllowed = (event.sessionId !== null) && (event.sessionId !== undefined);

                            // SessionIDs supported
                            if (moreSessionsAllowed) {

                                // Attempt to find an uninitialized token with this sessionID
                                sessionToken = findSessionByID(sessions, event.sessionId);
                                if (!sessionToken && pendingSessions.length > 0) {

                                    // This is the first message for our latest session, so set the
                                    // sessionID and add it to our list
                                    sessionToken = pendingSessions.shift();
                                    sessions.push(sessionToken);
                                    sessionToken.sessionID = event.sessionId;
                                }
                            } else if (pendingSessions.length > 0) { // SessionIDs not supported

                                sessionToken = pendingSessions.shift();
                                sessions.push(sessionToken);

                                if (pendingSessions.length !== 0) {
                                    errHandler.mediaKeyMessageError("Multiple key sessions were creates with a user-agent that does not support sessionIDs!! Unpredictable behavior ahead!");
                                }
                            }

                            if (sessionToken) {
                                var message = ArrayBuffer.isView(event.message) ? event.message.buffer : event.message;

                                // For ClearKey, the spec mandates that you pass this message to the
                                // addKey method, so we always save it to the token since there is no
                                // way to tell which key system is in use
                                sessionToken.keyMessage = message;
                                EventBus.trigger(Events.KEY_MESSAGE, {data:new KeyMessage(sessionToken, message, event.defaultURL)});

                            } else {
                                self.log("No session token found for key message");
                            }
                            break;
                    }
                }
            };
        },
        eventHandler = null,

        /**
         * Helper function to retrieve the stored session token based on a given
         * sessionID value
         *
         * @param sessionArray {Array} the array of sessions to search
         * @param sessionID the sessionID to search for
         * @returns {*} the session token with the given sessionID
         */
        findSessionByID = function(sessionArray, sessionID) {

            if (!sessionID || !sessionArray) {
                return null;
            } else {
                var len = sessionArray.length;
                for (var i = 0; i < len; i++) {
                    if (sessionArray[i].sessionID == sessionID) {
                        return sessionArray[i];
                    }
                }
                return null;
            }
        },

        removeEventListeners = function() {
            videoElement.removeEventListener(api.keyerror, eventHandler);
            videoElement.removeEventListener(api.needkey, eventHandler);
            videoElement.removeEventListener(api.keymessage, eventHandler);
            videoElement.removeEventListener(api.keyadded, eventHandler);
        };

    return {
        system: undefined,
        log: undefined,
        keySystem: null,

        setup: function() {
            eventHandler = createEventHandler.call(this);
        },

        /**
         * Initialize this protection model
         */
        init: function() {
            var tmpVideoElement = document.createElement("video");
            api = ProtectionModel_01b.detect(tmpVideoElement);
        },

        teardown: function() {
            if (videoElement) {
                removeEventListeners();
            }
            for (var i = 0; i < sessions.length; i++) {
                this.closeKeySession(sessions[i]);
            }
            EventBus.trigger(Events.TEARDOWN_COMPLETE);
        },

        getAllInitData: function() {
            var i, retVal = [];
            for (i = 0; i < pendingSessions.length; i++) {
                retVal.push(pendingSessions[i].initData);
            }
            for (i = 0; i < sessions.length; i++) {
                retVal.push(sessions[i].initData);
            }
            return retVal;
        },

        requestKeySystemAccess: function(ksConfigurations) {
            var ve = videoElement;
            if (!ve) { // Must have a video element to do this capability tests
                ve = document.createElement("video");
            }

            // Try key systems in order, first one with supported key system configuration
            // is used
            var found = false;
            for (var ksIdx = 0; ksIdx < ksConfigurations.length; ksIdx++) {
                var systemString = ksConfigurations[ksIdx].ks.systemString;
                var configs = ksConfigurations[ksIdx].configs;
                var supportedAudio = null;
                var supportedVideo = null;

                // Try key system configs in order, first one with supported audio/video
                // is used
                for (var configIdx = 0; configIdx < configs.length; configIdx++) {
                    //var audios = configs[configIdx].audioCapabilities;
                    var videos = configs[configIdx].videoCapabilities;

                    // Look for supported audio container/codecs
                    /*
                    if (audios && audios.length !== 0) {
                        supportedAudio = []; // Indicates that we have a requested audio config
                        for (var audioIdx = 0; audioIdx < audios.length; audioIdx++) {
                            if (ve.canPlayType(audios[audioIdx].contentType, systemString) !== "") {
                                supportedAudio.push(audios[audioIdx]);
                            }
                        }
                    }
                    */

                    // Look for supported video container/codecs
                    if (videos && videos.length !== 0) {
                        supportedVideo = []; // Indicates that we have a requested video config
                        for (var videoIdx = 0; videoIdx < videos.length; videoIdx++) {
                            if (ve.canPlayType(videos[videoIdx].contentType, systemString) !== "") {
                                supportedVideo.push(videos[videoIdx]);
                            }
                        }
                    }

                    // No supported audio or video in this configuration OR we have
                    // requested audio or video configuration that is not supported
                    if ((!supportedAudio && !supportedVideo) ||
                            (supportedAudio && supportedAudio.length === 0) ||
                            (supportedVideo && supportedVideo.length === 0)) {
                        continue;
                    }

                    // This configuration is supported
                    found = true;
                    var ksConfig = new KeySystemConfiguration(supportedAudio, supportedVideo);
                    var ks = protectionExt.getKeySystemBySystemString(systemString);
                    EventBus.trigger(Events.KEY_SYSTEM_ACCESS_COMPLETE, {data:new KeySystemAccess(ks, ksConfig)})
                    break;
                }
            }
            if (!found) {
                EventBus.trigger(Events.KEY_SYSTEM_ACCESS_COMPLETE, {error:"Key system access denied! -- No valid audio/video content configurations detected!"});
            }
        },

        selectKeySystem: function(keySystemAccess) {
            this.keySystem = keySystemAccess.keySystem;
            EventBus.trigger(Events.INTERNAL_KEY_SYSTEM_SELECTED);
        },

        setMediaElement: function(mediaElement) {
            if (videoElement === mediaElement) {
                return;
            }

            // Replacing the previous element
            if (videoElement) {
                removeEventListeners();
            }

            videoElement = mediaElement;

            // Only if we are not detaching from the existing element
            if (videoElement) {
                videoElement.addEventListener(api.keyerror, eventHandler);
                videoElement.addEventListener(api.needkey, eventHandler);
                videoElement.addEventListener(api.keymessage, eventHandler);
                videoElement.addEventListener(api.keyadded, eventHandler);
                EventBus.trigger(Events.VIDEO_ELEMENT_SELECTED);
            }
        },

        createKeySession: function(initData /*, keySystemType */) {

            if (!this.keySystem) {
                throw new Error("Can not create sessions until you have selected a key system");
            }

            // Determine if creating a new session is allowed
            if (moreSessionsAllowed || sessions.length === 0) {

                var newSession = { // Implements SessionToken
                    sessionID: null,
                    initData: initData,

                    getSessionID: function() {
                        return this.sessionID;
                    },

                    getExpirationTime: function() {
                        return NaN;
                    },

                    getSessionType: function() {
                        return "temporary";
                    }
                };
                pendingSessions.push(newSession);

                // Send our request to the CDM
                videoElement[api.generateKeyRequest](this.keySystem.systemString, new Uint8Array(initData));

                return newSession;

            } else {
                throw new Error("Multiple sessions not allowed!");
            }

        },

        updateKeySession: function(sessionToken, message) {
            var sessionID = sessionToken.sessionID;
            if (!protectionExt.isClearKey(this.keySystem)) {
                // Send our request to the CDM
                videoElement[api.addKey](this.keySystem.systemString,
                        new Uint8Array(message), sessionToken.initData, sessionID);
            } else {
                // For clearkey, message is a ClearKeyKeySet
                for (var i = 0; i < message.keyPairs.length; i++) {
                    videoElement[api.addKey](this.keySystem.systemString,
                            message.keyPairs[i].key, message.keyPairs[i].keyID, sessionID);
                }
            }
        },

        closeKeySession: function(sessionToken) {
            // Send our request to the CDM
            videoElement[api.cancelKeyRequest](this.keySystem.systemString, sessionToken.sessionID);
        },

        setServerCertificate: function(/*serverCertificate*/) { /* Not supported */ },

        loadKeySession: function(/*sessionID*/) { /* Not supported */ },

        removeKeySession: function(/*sessionToken*/) { /* Not supported */ }
    };
};

ProtectionModel_01b.prototype = {
    constructor: ProtectionModel_01b
};

// Defines the supported 0.1b API variations
ProtectionModel_01b.APIs = [
    // Un-prefixed as per spec
    {
        // Video Element
        generateKeyRequest: "generateKeyRequest",
        addKey: "addKey",
        cancelKeyRequest: "cancelKeyRequest",

        // Events
        needkey: "needkey",
        keyerror: "keyerror",
        keyadded: "keyadded",
        keymessage: "keymessage"
    },
    // Webkit-prefixed (early Chrome versions and Chrome with EME disabled in chrome://flags)
    {
        // Video Element
        generateKeyRequest: "webkitGenerateKeyRequest",
        addKey: "webkitAddKey",
        cancelKeyRequest: "webkitCancelKeyRequest",

        // Events
        needkey: "webkitneedkey",
        keyerror: "webkitkeyerror",
        keyadded: "webkitkeyadded",
        keymessage: "webkitkeymessage"
    }
];

/**
 * Detects presence of EME v0.1b APIs
 *
 * @param videoElement {HTMLMediaElement} the media element that will be
 * used for detecting APIs
 * @returns an API object that is used when initializing the ProtectionModel
 * instance, or null if this EME version is not supported
 */
ProtectionModel_01b.detect = function(videoElement) {
    var apis = ProtectionModel_01b.APIs;
    for (var i = 0; i < apis.length; i++) {
        var api = apis[i];
        if (typeof videoElement[api.generateKeyRequest] !== 'function') {
            continue;
        }
        if (typeof videoElement[api.addKey] !== 'function') {
            continue;
        }
        if (typeof videoElement[api.cancelKeyRequest] !== 'function') {
            continue;
        }
        return api;
    }

    return null;
};


export default ProtectionModel_01b;