/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Based on https://github.com/emailjs/emailjs-smtp-client
 *
 * Copyright (c) 2013 Andris Reinman
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

const EXPORTED_SYMBOLS = ["SmtpClient"];

var { AppConstants } = ChromeUtils.import(
  "resource://gre/modules/AppConstants.jsm"
);
var { setTimeout, clearTimeout } = ChromeUtils.import(
  "resource://gre/modules/Timer.jsm"
);
var { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
var { MailCryptoUtils } = ChromeUtils.import(
  "resource:///modules/MailCryptoUtils.jsm"
);
var { SmtpAuthenticator } = ChromeUtils.import(
  "resource:///modules/MailAuthenticator.jsm"
);
var { MsgUtils } = ChromeUtils.import(
  "resource:///modules/MimeMessageUtils.jsm"
);

const NS_ERROR_BUT_DONT_SHOW_ALERT = 0x805530ef;

/**
 * Lower Bound for socket timeout to wait since the last data was written to a socket
 */
const TIMEOUT_SOCKET_LOWER_BOUND = 10000;

/**
 * Multiplier for socket timeout:
 *
 * We assume at least a GPRS connection with 115 kb/s = 14,375 kB/s tops, so 10 KB/s to be on
 * the safe side. We can timeout after a lower bound of 10s + (n KB / 10 KB/s). A 1 MB message
 * upload would be 110 seconds to wait for the timeout. 10 KB/s === 0.1 s/B
 */
const TIMEOUT_SOCKET_MULTIPLIER = 0.1;

class SmtpClient {
  /**
   * Creates a connection object to a SMTP server and allows to send mail through it.
   * Call `connect` method to inititate the actual connection, the constructor only
   * defines the properties but does not actually connect.
   *
   * @constructor
   *
   * @param {nsISmtpServer} server - The associated nsISmtpServer instance.
   */
  constructor(server) {
    this.options = {
      ignoreTLS: server.socketType == Ci.nsMsgSocketType.plain,
      requireTLS: server.socketType == Ci.nsMsgSocketType.SSL,
    };

    this.timeoutSocketLowerBound = TIMEOUT_SOCKET_LOWER_BOUND;
    this.timeoutSocketMultiplier = TIMEOUT_SOCKET_MULTIPLIER;

    this.socket = false; // Downstream TCP socket to the SMTP server, created with TCPSocket
    this.waitDrain = false; // Keeps track if the downstream socket is currently full and a drain event should be waited for or not

    // Private properties

    // Indicates if the connection has been closed and can't be used anymore
    this._destroyed = false;

    this._server = server;
    this._authenticator = new SmtpAuthenticator(server);
    this._authenticating = false;
    // A list of auth methods detected from the EHLO response.
    this._supportedAuthMethods = [];
    // A list of auth methods that worth a try.
    this._possibleAuthMethods = [];
    // Auth method set by user preference.
    this._preferredAuthMethods =
      {
        [Ci.nsMsgAuthMethod.passwordCleartext]: ["PLAIN", "LOGIN"],
        [Ci.nsMsgAuthMethod.passwordEncrypted]: ["CRAM-MD5"],
        [Ci.nsMsgAuthMethod.GSSAPI]: ["GSSAPI"],
        [Ci.nsMsgAuthMethod.NTLM]: ["NTLM"],
        [Ci.nsMsgAuthMethod.OAuth2]: ["XOAUTH2"],
        [Ci.nsMsgAuthMethod.secure]: ["CRAM-MD5", "XOAUTH2"],
      }[server.authMethod] || [];
    // The next auth method to try if the current failed.
    this._nextAuthMethod = null;

    // A list of capabilities detected from the EHLO response.
    this._capabilities = [];

    this._dataMode = false; // If true, accepts data from the upstream to be passed directly to the downstream socket. Used after the DATA command
    this._lastDataBytes = ""; // Keep track of the last bytes to see how the terminating dot should be placed
    this._envelope = null; // Envelope object for tracking who is sending mail to whom
    this._currentAction = null; // Stores the function that should be run after a response has been received from the server
    this._secureMode = this.options.requireTLS; // Indicates if the connection is secured or plaintext
    this._socketTimeoutTimer = false; // Timer waiting to declare the socket dead starting from the last write
    this._socketTimeoutStart = false; // Start time of sending the first packet in data mode
    this._socketTimeoutPeriod = false; // Timeout for sending in data mode, gets extended with every send()

    this._parseBlock = { data: [], statusCode: null };
    this._parseRemainder = ""; // If the complete line is not received yet, contains the beginning of it

    this.logger = MsgUtils.smtpLogger;

    // Event placeholders
    this.onerror = (e, failedSecInfo) => {}; // Will be run when an error occurs. The `onclose` event will fire subsequently.
    this.ondrain = () => {}; // More data can be buffered in the socket.
    this.onclose = () => {}; // The connection to the server has been closed
    this.onidle = () => {}; // The connection is established and idle, you can send mail now
    this.onready = failedRecipients => {}; // Waiting for mail body, lists addresses that were not accepted as recipients
    this.ondone = success => {}; // The mail has been sent. Wait for `onidle` next. Indicates if the message was queued by the server.
  }

  /**
   * Initiate a connection to the server
   */
  connect() {
    let port = this._server.port || (this.options.requireTLS ? 465 : 587);
    this.socket = new TCPSocket(this._server.hostname, port, {
      binaryType: "arraybuffer",
      useSecureTransport: this._secureMode,
    });

    // allows certificate handling for platform w/o native tls support
    // oncert is non standard so setting it might throw if the socket object is immutable
    try {
      this.socket.oncert = this.oncert;
    } catch (E) {}
    this.socket.onerror = this._onError.bind(this);
    this.socket.onopen = this._onOpen.bind(this);

    this._destroyed = false;
  }

  /**
   * Sends QUIT
   */
  quit() {
    this._sendCommand("QUIT");
    this._currentAction = this.close;
  }

  /**
   * Closes the connection to the server
   */
  close() {
    this.logger.debug("Closing connection...");
    if (this.socket && this.socket.readyState === "open") {
      this.socket.close();
    } else {
      this._destroy();
    }
  }

  // Mail related methods

  /**
   * Initiates a new message by submitting envelope data, starting with
   * `MAIL FROM:` command. Use after `onidle` event
   *
   * @param {object} envelope - The envelope object.
   * @param {string} envelope.from - The from address.
   * @param {string[]} envelope.to - The to addresses.
   * @param {number} envelope.size - The file size.
   * @param {boolean} envelope.requestDSN - Whether to request Delivery Status Notifications.
   * @param {boolean} envelope.messageId - The message id.
   */
  useEnvelope(envelope) {
    this._envelope = envelope || {};
    this._envelope.from = [].concat(
      this._envelope.from || "anonymous@" + this._getHelloArgument()
    )[0];

    if (!this._capabilities.includes("SMTPUTF8")) {
      // If server doesn't support SMTPUTF8, check if addresses contain invalid
      // characters.

      let recipients = this._envelope.to;
      this._envelope.to = [];

      for (let recipient of recipients) {
        let lastAt = null;
        let firstInvalid = null;
        for (let i = 0; i < recipient.length; i++) {
          let ch = recipient[i];
          if (ch == "@") {
            lastAt = i;
          } else if ((ch < " " || ch > "~") && ch != "\t") {
            firstInvalid = i;
            break;
          }
        }
        if (firstInvalid != null) {
          if (!lastAt) {
            // Invalid char found in the localpart, throw error until we implement RFC 6532.
            this.onerror(NS_ERROR_BUT_DONT_SHOW_ALERT, null);
            return;
          }
          // Invalid char found in the domainpart, convert it to ACE.
          let idnService = Cc["@mozilla.org/network/idn-service;1"].getService(
            Ci.nsIIDNService
          );
          let domain = idnService.convertUTF8toACE(recipient.slice(lastAt + 1));
          recipient = `${recipient.slice(0, lastAt)}@${domain}`;
        }
        this._envelope.to.push(recipient);
      }
    }

    // clone the recipients array for latter manipulation
    this._envelope.rcptQueue = [].concat(this._envelope.to);
    this._envelope.rcptFailed = [];
    this._envelope.responseQueue = [];

    this._currentAction = this._actionMAIL;
    let cmd = `MAIL FROM:<${this._envelope.from}>`;
    if (
      this._capabilities.includes("8BITMIME") &&
      !Services.prefs.getBoolPref("mail.strictly_mime", false)
    ) {
      cmd += " BODY=8BITMIME";
    }
    if (this._capabilities.includes("SMTPUTF8")) {
      cmd += " SMTPUTF8";
    }
    if (this._capabilities.includes("SIZE")) {
      cmd += ` SIZE=${this._envelope.size}`;
    }
    if (this._capabilities.includes("DSN")) {
      let ret = Services.prefs.getBoolPref("mail.dsn.ret_full_on")
        ? "FULL"
        : "HDRS";
      cmd += ` RET=${ret} ENVID=${envelope.messageId}`;
    }
    this._sendCommand(cmd);
  }

  /**
   * Send ASCII data to the server. Works only in data mode (after `onready` event), ignored
   * otherwise
   *
   * @param {String} chunk ASCII string (quoted-printable, base64 etc.) to be sent to the server
   * @return {Boolean} If true, it is safe to send more data, if false, you *should* wait for the ondrain event before sending more
   */
  send(chunk) {
    // works only in data mode
    if (!this._dataMode) {
      // this line should never be reached but if it does,
      // act like everything's normal.
      return true;
    }

    // TODO: if the chunk is an arraybuffer, use a separate function to send the data
    return this._sendString(chunk);
  }

  /**
   * Indicates that a data stream for the socket is ended. Works only in data
   * mode (after `onready` event), ignored otherwise. Use it when you are done
   * with sending the mail. This method does not close the socket. Once the mail
   * has been queued by the server, `ondone` and `onidle` are emitted.
   *
   * @param {Buffer} [chunk] Chunk of data to be sent to the server
   */
  end(chunk) {
    // works only in data mode
    if (!this._dataMode) {
      // this line should never be reached but if it does,
      // act like everything's normal.
      return true;
    }

    if (chunk && chunk.length) {
      this.send(chunk);
    }

    // redirect output from the server to _actionStream
    this._currentAction = this._actionStream;

    // indicate that the stream has ended by sending a single dot on its own line
    // if the client already closed the data with \r\n no need to do it again
    if (this._lastDataBytes === "\r\n") {
      this.waitDrain = this._send(new Uint8Array([0x2e, 0x0d, 0x0a]).buffer); // .\r\n
    } else if (this._lastDataBytes.substr(-1) === "\r") {
      this.waitDrain = this._send(
        new Uint8Array([0x0a, 0x2e, 0x0d, 0x0a]).buffer
      ); // \n.\r\n
    } else {
      this.waitDrain = this._send(
        new Uint8Array([0x0d, 0x0a, 0x2e, 0x0d, 0x0a]).buffer
      ); // \r\n.\r\n
    }

    // end data mode, reset the variables for extending the timeout in data mode
    this._dataMode = false;
    this._socketTimeoutStart = false;
    this._socketTimeoutPeriod = false;

    return this.waitDrain;
  }

  // PRIVATE METHODS

  /**
   * Queue some data from the server for parsing.
   *
   * @param {String} chunk Chunk of data received from the server
   */
  _parse(chunk) {
    // Lines should always end with <CR><LF> but you never know, might be only <LF> as well
    var lines = (this._parseRemainder + (chunk || "")).split(/\r?\n/);
    this._parseRemainder = lines.pop(); // not sure if the line has completely arrived yet

    for (let i = 0, len = lines.length; i < len; i++) {
      if (!lines[i].trim()) {
        // nothing to check, empty line
        continue;
      }

      // possible input strings for the regex:
      // 250-MULTILINE REPLY
      // 250 LAST LINE OF REPLY
      // 250 1.2.3 MESSAGE

      const match = lines[i].match(
        /^(\d{3})([- ])(?:(\d+\.\d+\.\d+)(?: ))?(.*)/
      );

      if (match) {
        this._parseBlock.data.push(match[4]);

        if (match[2] === "-") {
          // this is a multiline reply
          this._parseBlock.statusCode =
            this._parseBlock.statusCode || Number(match[1]);
        } else {
          const statusCode = Number(match[1]) || 0;
          const response = {
            statusCode,
            data: this._parseBlock.data.join("\n"),
            // Success means can move to the next step. Though 3xx is not
            // failure, we don't consider it success here.
            success: statusCode >= 200 && statusCode < 300,
          };

          this._onCommand(response);
          this._parseBlock = {
            data: [],
            statusCode: null,
          };
        }
      } else {
        this._onCommand({
          success: false,
          statusCode: this._parseBlock.statusCode || null,
          data: [lines[i]].join("\n"),
        });
        this._parseBlock = {
          data: [],
          statusCode: null,
        };
      }
    }
  }

  // EVENT HANDLERS FOR THE SOCKET

  /**
   * Connection listener that is run when the connection to the server is opened.
   * Sets up different event handlers for the opened socket
   */
  _onOpen() {
    this.socket.ondata = this._onData.bind(this);

    this.socket.onclose = this._onClose.bind(this);
    this.socket.ondrain = this._onDrain.bind(this);

    this._currentAction = this._actionGreeting;
  }

  /**
   * Data listener for chunks of data emitted by the server
   *
   * @event
   * @param {Event} evt Event object. See `evt.data` for the chunk received
   */
  _onData(evt) {
    clearTimeout(this._socketTimeoutTimer);
    var stringPayload = new TextDecoder("UTF-8").decode(
      new Uint8Array(evt.data)
    );
    // "S: " to denote that this is data from the Server.
    this.logger.debug(`S: ${stringPayload}`);
    this._parse(stringPayload);
  }

  /**
   * More data can be buffered in the socket, `waitDrain` is reset to false
   *
   * @event
   * @param {Event} evt Event object. Not used
   */
  _onDrain() {
    this.waitDrain = false;
    this.ondrain();
  }

  /**
   * Error handler. Emits an nsresult value.
   *
   * @param {Error|TCPSocketErrorEvent} e - An Error or TCPSocketErrorEvent object.
   */
  _onError(e) {
    this.logger.error(e);
    let nsError = Cr.NS_ERROR_FAILURE;
    let secInfo = null;
    if (TCPSocketErrorEvent.isInstance(e)) {
      nsError = e.errorCode;
      secInfo = e.target.transport?.securityInfo;
    }
    // Use nsresult to integrate with other parts of sending process, e.g.
    // MessageSend.jsm will show an error message depending on the nsresult.
    this.onerror(nsError, "", secInfo);
    this.close();
  }

  /**
   * Error handler. Emits an nsresult value.
   *
   * @param {nsresult} nsError - A nsresult.
   * @param {string} serverError - Error message returned from the SMTP server.
   */
  _onNsError(nsError, serverError) {
    let errorName = MsgUtils.getErrorStringName(nsError);
    let errorMessage = "";
    if (
      [
        MsgUtils.NS_ERROR_SMTP_SERVER_ERROR,
        MsgUtils.NS_ERROR_SMTP_TEMP_SIZE_EXCEEDED,
        MsgUtils.NS_ERROR_SMTP_PERM_SIZE_EXCEEDED_2,
        MsgUtils.NS_ERROR_SENDING_FROM_COMMAND,
        MsgUtils.NS_ERROR_SENDING_RCPT_COMMAND,
        MsgUtils.NS_ERROR_SENDING_DATA_COMMAND,
        MsgUtils.NS_ERROR_SENDING_MESSAGE,
      ].includes(nsError)
    ) {
      let bundle = Services.strings.createBundle(
        "chrome://messenger/locale/messengercompose/composeMsgs.properties"
      );
      errorMessage = bundle.formatStringFromName(errorName, [serverError]);
    }
    this.onerror(nsError, errorMessage);
    this.close();
  }

  /**
   * Indicates that the socket has been closed
   *
   * @event
   * @param {Event} evt Event object. Not used
   */
  _onClose() {
    this.logger.debug("Socket closed.");
    this._destroy();
    if (this._authenticating) {
      // In some cases, socket is closed for invalid username/password.
      this._onAuthFailed({ data: "Socket closed." });
    }
  }

  /**
   * This is not a socket data handler but the handler for data emitted by the parser,
   * so this data is safe to use as it is always complete (server might send partial chunks)
   *
   * @event
   * @param {Object} command Parsed data
   */
  _onCommand(command) {
    if (command.statusCode < 200 || command.statusCode >= 400) {
      this.logger.error(
        `Command failed: ${command.statusCode} ${command.data}; currentAction=${this._currentAction?.name}`
      );
    }
    if (typeof this._currentAction === "function") {
      this._currentAction(command);
    }
  }

  _onTimeout() {
    this.logger.error("Socket timed out.");
    this._destroy();
    if (this._authenticating) {
      // In some cases, socket timed out for invalid username/password.
      this._onAuthFailed({ data: "Socket timed out." });
    }
  }

  /**
   * Ensures that the connection is closed and such
   */
  _destroy() {
    clearTimeout(this._socketTimeoutTimer);

    if (!this._destroyed) {
      this._destroyed = true;
      this.onclose();
    }
  }

  /**
   * Sends a string to the socket.
   *
   * @param {String} chunk ASCII string (quoted-printable, base64 etc.) to be sent to the server
   * @return {Boolean} If true, it is safe to send more data, if false, you *should* wait for the ondrain event before sending more
   */
  _sendString(chunk) {
    // escape dots
    if (!this.options.disableEscaping) {
      chunk = chunk.replace(/\n\./g, "\n..");
      if (
        (this._lastDataBytes.substr(-1) === "\n" || !this._lastDataBytes) &&
        chunk.charAt(0) === "."
      ) {
        chunk = "." + chunk;
      }
    }

    // Keeping eye on the last bytes sent, to see if there is a <CR><LF> sequence
    // at the end which is needed to end the data stream
    if (chunk.length > 2) {
      this._lastDataBytes = chunk.substr(-2);
    } else if (chunk.length === 1) {
      this._lastDataBytes = this._lastDataBytes.substr(-1) + chunk;
    }

    this.logger.debug("Sending " + chunk.length + " bytes of payload");

    // pass the chunk to the socket
    this.waitDrain = this._send(
      MailCryptoUtils.binaryStringToTypedArray(chunk).buffer
    );
    return this.waitDrain;
  }

  /**
   * Send a string command to the server, also append CRLF if needed.
   *
   * @param {string} str - String to be sent to the server.
   * @param {boolean} [suppressLogging=false] - If true and not in dev mode,
   *   do not log the str. For non-release builds output won't be suppressed,
   *   so that debugging auth problems is easier.
   */
  _sendCommand(str, suppressLogging = false) {
    // "C: " is used to denote that this is data from the Client.
    if (suppressLogging && AppConstants.MOZ_UPDATE_CHANNEL != "default") {
      this.logger.debug(
        "C: Logging suppressed (it probably contained auth information)"
      );
    } else {
      this.logger.debug(`C: ${str}`);
    }
    this.waitDrain = this._send(
      new TextEncoder().encode(str + (str.substr(-2) !== "\r\n" ? "\r\n" : ""))
        .buffer
    );
  }

  _send(buffer) {
    this._setTimeout(buffer.byteLength);
    return this.socket.send(buffer);
  }

  _setTimeout(byteLength) {
    var prolongPeriod = Math.floor(byteLength * this.timeoutSocketMultiplier);
    var timeout;

    if (this._dataMode) {
      // we're in data mode, so we count only one timeout that get extended for every send().
      var now = Date.now();

      // the old timeout start time
      this._socketTimeoutStart = this._socketTimeoutStart || now;

      // the old timeout period, normalized to a minimum of TIMEOUT_SOCKET_LOWER_BOUND
      this._socketTimeoutPeriod =
        (this._socketTimeoutPeriod || this.timeoutSocketLowerBound) +
        prolongPeriod;

      // the new timeout is the delta between the new firing time (= timeout period + timeout start time) and now
      timeout = this._socketTimeoutStart + this._socketTimeoutPeriod - now;
    } else {
      // set new timout
      timeout = this.timeoutSocketLowerBound + prolongPeriod;
    }

    clearTimeout(this._socketTimeoutTimer); // clear pending timeouts
    this._socketTimeoutTimer = setTimeout(this._onTimeout.bind(this), timeout); // arm the next timeout
  }

  /**
   * Intitiate authentication sequence if needed
   * @param {boolean} forceNewPassword - Discard cached password.
   */
  async _authenticateUser(forceNewPassword) {
    if (
      this._preferredAuthMethods.length == 0 ||
      this._supportedAuthMethods.length == 0
    ) {
      // no need to authenticate, at least no data given
      this._currentAction = this._actionIdle;
      this.onidle(); // ready to take orders
      return;
    }

    if (!this._nextAuthMethod) {
      this._onError(new Error("No available auth method."));
      return;
    }

    this._authenticating = true;

    let auth = this._nextAuthMethod;
    this._nextAuthMethod = this._possibleAuthMethods[
      this._possibleAuthMethods.indexOf(auth) + 1
    ];
    this.logger.debug(`Current auth method: ${auth}`);

    switch (auth) {
      case "LOGIN":
        // LOGIN is a 3 step authentication process
        // C: AUTH LOGIN
        // C: BASE64(USER)
        // C: BASE64(PASS)
        this.logger.debug("Authentication via AUTH LOGIN");
        this._currentAction = this._actionAUTH_LOGIN_USER;
        this._sendCommand("AUTH LOGIN");
        return;
      case "PLAIN":
        // AUTH PLAIN is a 1 step authentication process
        // C: AUTH PLAIN BASE64(\0 USER \0 PASS)
        this.logger.debug("Authentication via AUTH PLAIN");
        this._currentAction = this._actionAUTHComplete;
        // According to rfc4616#section-2, password should be UTF-8 BinaryString
        // before base64 encoded.
        let password = String.fromCharCode(
          ...new TextEncoder().encode(this._authenticator.getPassword())
        );

        this._sendCommand(
          // convert to BASE64
          "AUTH PLAIN " +
            btoa(
              "\u0000" + // skip authorization identity as it causes problems with some servers
                this._authenticator.username +
                "\u0000" +
                password
            ),
          true
        );
        return;
      case "CRAM-MD5":
        this.logger.debug("Authentication via AUTH CRAM-MD5");
        this._currentAction = this._actionAUTH_CRAM;
        this._sendCommand("AUTH CRAM-MD5");
        return;
      case "XOAUTH2":
        // See https://developers.google.com/gmail/xoauth2_protocol#smtp_protocol_exchange
        this.logger.debug("Authentication via AUTH XOAUTH2");
        this._currentAction = this._actionAUTH_XOAUTH2;
        let oauthToken = await this._authenticator.getOAuthToken();
        this._sendCommand("AUTH XOAUTH2 " + oauthToken, true);
        return;
      case "GSSAPI": {
        this.logger.debug("Authentication via AUTH GSSAPI");
        this._currentAction = this._actionAUTH_GSSAPI;
        this._authenticator.initGssapiAuth("smtp");
        let token;
        try {
          token = this._authenticator.getNextGssapiToken("");
        } catch (e) {
          this.logger.error(e);
          this._actionAUTHComplete({ success: false, data: "AUTH GSSAPI" });
          return;
        }
        this._sendCommand(`AUTH GSSAPI ${token}`, true);
        return;
      }
      case "NTLM": {
        this.logger.debug("Authentication via AUTH NTLM");
        this._currentAction = this._actionAUTH_NTLM;
        this._authenticator.initNtlmAuth("smtp");
        let token;
        try {
          token = this._authenticator.getNextNtlmToken("");
        } catch (e) {
          this.logger.error(e);
          this._actionAUTHComplete({ success: false, data: "AUTH NTLM" });
          return;
        }
        this._sendCommand(`AUTH NTLM ${token}`, true);
        return;
      }
    }

    this._onError(new Error(`Unknown authentication method ${auth}`));
  }

  _onAuthFailed(command) {
    this.logger.error(`Authentication failed: ${command.data}`);
    if (this._nextAuthMethod && !this._destroyed) {
      // Try the next auth method.
      this._authenticateUser();
      return;
    }

    // Ask user what to do.
    let action = this._authenticator.promptAuthFailed();
    if (action == 1) {
      // Cancel button pressed.
      this.logger.error(`Authentication failed: ${command.data}`);
      this._onNsError(MsgUtils.NS_ERROR_SMTP_AUTH_FAILURE);
      return;
    } else if (action == 2) {
      // 'New password' button pressed. Forget cached password, new password
      // will be asked.
      this._authenticator.forgetPassword();
    }

    if (this._destroyed) {
      // If connection is lost, reconnect.
      this.connect();
      return;
    }

    // Reset _nextAuthMethod to start again.
    this._nextAuthMethod = this._possibleAuthMethods[0];
    if (action == 2 || action == 0) {
      // action = 0 means retry button pressed.
      this._authenticateUser();
    }
  }

  _getHelloArgument() {
    let helloArgument = this._server.helloArgument;
    if (helloArgument) {
      return helloArgument;
    }

    try {
      // The address format follows rfc5321#section-4.1.3.
      let netAddr = this.socket?.transport.getScriptableSelfAddr();
      let address = netAddr.address;
      if (netAddr.family === Ci.nsINetAddr.FAMILY_INET6) {
        return `[IPV6:${address}]`;
      }
      return `[${address}]`;
    } catch (e) {}

    return "[127.0.0.1]";
  }

  // ACTIONS FOR RESPONSES FROM THE SMTP SERVER

  /**
   * Initial response from the server, must have a status 220
   *
   * @param {Object} command Parsed command from the server {statusCode, data}
   */
  _actionGreeting(command) {
    if (command.statusCode !== 220) {
      this._onError(new Error("Invalid greeting: " + command.data));
      return;
    }

    if (this.options.lmtp) {
      this._currentAction = this._actionLHLO;
      this._sendCommand("LHLO " + this._getHelloArgument());
    } else {
      this._currentAction = this._actionEHLO;
      this._sendCommand("EHLO " + this._getHelloArgument());
    }
  }

  /**
   * Response to LHLO
   *
   * @param {Object} command Parsed command from the server {statusCode, data}
   */
  _actionLHLO(command) {
    if (!command.success) {
      this._onError(new Error(`LHLO not successful: ${command.data}`));
      return;
    }

    // Process as EHLO response
    this._actionEHLO(command);
  }

  /**
   * Response to EHLO. If the response is an error, try HELO instead
   *
   * @param {Object} command Parsed command from the server {statusCode, data}
   */
  _actionEHLO(command) {
    var match;

    if ([500, 502].includes(command.statusCode)) {
      // EHLO is not implemented by the server.
      if (this._server.socketType == Ci.nsMsgSocketType.alwaysSTARTTLS) {
        // If alwaysSTARTTLS is set by the user, EHLO is required to advertise it.
        this._onNsError(MsgUtils.NS_ERROR_STARTTLS_FAILED_EHLO_STARTTLS);
        return;
      }

      // Try HELO instead
      this.logger.warn(
        "EHLO not successful, trying HELO " + this._getHelloArgument()
      );
      this._currentAction = this._actionHELO;
      this._sendCommand("HELO " + this._getHelloArgument());
      return;
    } else if (!command.success) {
      // 501 Syntax error or some other error.
      this._onNsError(MsgUtils.NS_ERROR_SMTP_SERVER_ERROR, command.data);
      return;
    }

    // Detect if the server supports STARTTLS
    if (
      command.data.match(/STARTTLS\s?$/im) &&
      !this._secureMode &&
      !this.options.ignoreTLS &&
      !this.options.requireTLS
    ) {
      this._currentAction = this._actionSTARTTLS;
      this._sendCommand("STARTTLS");
      return;
    }

    this._supportedAuthMethods = [];

    // Detect if the server supports PLAIN auth
    if (command.data.match(/AUTH(?:\s+[^\n]*\s+|\s+)PLAIN/i)) {
      this._supportedAuthMethods.push("PLAIN");
    }

    // Detect if the server supports LOGIN auth
    if (command.data.match(/AUTH(?:\s+[^\n]*\s+|\s+)LOGIN/i)) {
      this._supportedAuthMethods.push("LOGIN");
    }

    // Detect if the server supports XOAUTH2 auth
    if (command.data.match(/AUTH(?:\s+[^\n]*\s+|\s+)XOAUTH2/i)) {
      this._supportedAuthMethods.push("XOAUTH2");
    }

    // Detect if the server supports CRAM-MD5 auth
    if (command.data.match(/AUTH(?:\s+[^\n]*\s+|\s+)CRAM-MD5/i)) {
      this._supportedAuthMethods.push("CRAM-MD5");
    }

    // Detect if the server supports GSSAPI auth
    if (command.data.match(/AUTH(?:\s+[^\n]*\s+|\s+)GSSAPI/i)) {
      this._supportedAuthMethods.push("GSSAPI");
    }

    // Detect if the server supports NTLM auth
    if (command.data.match(/AUTH(?:\s+[^\n]*\s+|\s+)NTLM/i)) {
      this._supportedAuthMethods.push("NTLM");
    }

    // If a preferred method is not supported by the server, no need to try it.
    this._possibleAuthMethods = this._preferredAuthMethods.filter(x =>
      this._supportedAuthMethods.includes(x)
    );
    this.logger.debug(`Possible auth methods: ${this._possibleAuthMethods}`);
    this._nextAuthMethod = this._possibleAuthMethods[0];

    // Detect maximum allowed message size
    if ((match = command.data.match(/SIZE (\d+)/i)) && Number(match[1])) {
      const maxAllowedSize = Number(match[1]);
      this.logger.debug("Maximum allowd message size: " + maxAllowedSize);
    }

    for (let cap of ["8BITMIME", "SIZE", "SMTPUTF8", "DSN"]) {
      if (new RegExp(cap, "i").test(command.data)) {
        this._capabilities.push(cap);
      }
    }

    this._authenticateUser();
  }

  /**
   * Handles server response for STARTTLS command. If there's an error
   * try HELO instead, otherwise initiate TLS upgrade. If the upgrade
   * succeedes restart the EHLO
   *
   * @param {String} str Message from the server
   */
  _actionSTARTTLS(command) {
    if (!command.success) {
      this._onError(new Error(`STARTTLS not successful: ${command.data}`));
      return;
    }

    this._secureMode = true;
    this.socket.upgradeToSecure();

    // restart protocol flow
    this._currentAction = this._actionEHLO;
    this._sendCommand("EHLO " + this._getHelloArgument());
  }

  /**
   * Response to HELO
   *
   * @param {Object} command Parsed command from the server {statusCode, data}
   */
  _actionHELO(command) {
    if (!command.success) {
      this._onNsError(MsgUtils.NS_ERROR_SMTP_SERVER_ERROR, command.data);
      return;
    }
    this._authenticateUser();
  }

  /**
   * Response to AUTH LOGIN, if successful expects base64 encoded username
   *
   * @param {Object} command Parsed command from the server {statusCode, data}
   */
  _actionAUTH_LOGIN_USER(command) {
    if (command.statusCode !== 334 || command.data !== "VXNlcm5hbWU6") {
      this._onError(
        new Error(
          'Invalid login sequence while waiting for "334 VXNlcm5hbWU6 ": ' +
            command.data
        )
      );
      return;
    }
    this.logger.debug("AUTH LOGIN USER successful");
    this._currentAction = this._actionAUTH_LOGIN_PASS;
    this._sendCommand(btoa(this._authenticator.username), true);
  }

  /**
   * Response to AUTH LOGIN username, if successful expects base64 encoded password
   *
   * @param {Object} command Parsed command from the server {statusCode, data}
   */
  _actionAUTH_LOGIN_PASS(command) {
    if (command.statusCode !== 334 || command.data !== "UGFzc3dvcmQ6") {
      this._onError(
        new Error(
          'Invalid login sequence while waiting for "334 UGFzc3dvcmQ6 ": ' +
            command.data
        )
      );
      return;
    }
    this.logger.debug("AUTH LOGIN PASS successful");
    this._currentAction = this._actionAUTHComplete;
    let password = this._authenticator.getPassword();
    if (
      !Services.prefs.getBoolPref(
        "mail.smtp_login_pop3_user_pass_auth_is_latin1",
        true
      )
    ) {
      // Unlike PLAIN auth, the payload of LOGIN auth is not standardized. When
      // `mail.smtp_login_pop3_user_pass_auth_is_latin1` is true, we apply
      // base64 encoding directly. Otherwise, we convert it to UTF-8
      // BinaryString first.
      password = String.fromCharCode(...new TextEncoder().encode(password));
    }
    this._sendCommand(btoa(password), true);
  }

  /**
   * Response to AUTH CRAM, if successful expects base64 encoded challenge.
   *
   * @param {Object} command Parsed command from the server {statusCode, data}
   */
  async _actionAUTH_CRAM(command) {
    if (command.statusCode !== 334) {
      this._onError(
        new Error("Invalid login sequence while waiting for CRAM challenge")
      );
      return;
    }
    // Server sent us a base64 encoded challenge.
    let challenge = atob(command.data);
    let password = this._authenticator.getPassword();
    // Use password as key, challenge as payload, generate a HMAC-MD5 signature.
    let signature = MailCryptoUtils.hmacMd5(
      new TextEncoder().encode(password),
      new TextEncoder().encode(challenge)
    );
    // Get the hex form of the signature.
    let hex = [...signature].map(x => x.toString(16).padStart(2, "0")).join("");
    this._currentAction = this._actionAUTHComplete;
    // Send the username and signature back to the server.
    this._sendCommand(btoa(`${this._authenticator.username} ${hex}`), true);
  }

  /**
   * Response to AUTH XOAUTH2 token, if error occurs send empty response
   *
   * @param {Object} command Parsed command from the server {statusCode, data}
   */
  _actionAUTH_XOAUTH2(command) {
    if (!command.success) {
      this.logger.warn("Error during AUTH XOAUTH2, sending empty response");
      this._sendCommand("");
      this._currentAction = this._actionAUTHComplete;
    } else {
      this._actionAUTHComplete(command);
    }
  }

  /**
   * Response to AUTH GSSAPI, if successful expects a base64 encoded challenge.
   *
   * @param {Object} command Parsed command from the server {statusCode, data}
   */
  _actionAUTH_GSSAPI(command) {
    // GSSAPI auth can be multiple steps. We exchange tokens with the server
    // until success or failure.
    if (command.success) {
      this._actionAUTHComplete(command);
      return;
    }
    if (command.statusCode !== 334) {
      this._onError(
        new Error(
          `Invalid login sequence while waiting for GSSAPI challenge, ${command}`
        )
      );
      return;
    }
    let token = this._authenticator.getNextGssapiToken(command.data);
    this._currentAction = this._actionAUTH_GSSAPI;
    this._sendCommand(token, true);
  }

  /**
   * Response to AUTH NTLM, if successful expects a base64 encoded challenge.
   *
   * @param {Object} command Parsed command from the server {statusCode, data}
   */
  _actionAUTH_NTLM(command) {
    // NTLM auth can be multiple steps. We exchange tokens with the server
    // until success or failure.
    if (command.success) {
      this._actionAUTHComplete(command);
      return;
    }
    if (command.statusCode !== 334) {
      this._onError(
        new Error(
          `Invalid login sequence while waiting for NTLM challenge, ${command}`
        )
      );
      return;
    }
    let token = this._authenticator.getNextNtlmToken(command.data);
    this._currentAction = this._actionAUTH_NTLM;
    this._sendCommand(token, true);
  }

  /**
   * Checks if authentication succeeded or not. If successfully authenticated
   * emit `idle` to indicate that an e-mail can be sent using this connection
   *
   * @param {Object} command Parsed command from the server {statusCode, data}
   */
  _actionAUTHComplete(command) {
    this._authenticating = false;
    if (!command.success) {
      this._onAuthFailed(command);
      return;
    }

    this.logger.debug("Authentication successful.");

    this._currentAction = this._actionIdle;
    this.onidle(); // ready to take orders
  }

  /**
   * Used when the connection is idle and the server emits timeout
   *
   * @param {Object} command Parsed command from the server {statusCode, data}
   */
  _actionIdle(command) {
    if (command.statusCode > 300) {
      this._onError(new Error(command.data));
      return;
    }

    this._onError(new Error(command.data));
  }

  /**
   * Response to MAIL FROM command. Proceed to defining RCPT TO list if successful
   *
   * @param {Object} command Parsed command from the server {statusCode, data}
   */
  _actionMAIL(command) {
    if (!command.success) {
      let errorCode = MsgUtils.NS_ERROR_SENDING_FROM_COMMAND;
      if (this._capabilities.includes("SIZE")) {
        if (command.statusCode == 452) {
          errorCode = MsgUtils.NS_ERROR_SMTP_TEMP_SIZE_EXCEEDED;
        } else if (command.statusCode == 552) {
          errorCode = MsgUtils.NS_ERROR_SMTP_PERM_SIZE_EXCEEDED_2;
        }
      }
      this._onNsError(errorCode, command.data);
      return;
    }

    if (!this._envelope.rcptQueue.length) {
      this._onError(new Error("Can't send mail - no recipients defined"));
      return;
    }
    this.logger.debug(
      "MAIL FROM successful, proceeding with " +
        this._envelope.rcptQueue.length +
        " recipients"
    );
    this.logger.debug("Adding recipient...");
    this._envelope.curRecipient = this._envelope.rcptQueue.shift();
    this._currentAction = this._actionRCPT;
    let cmd = `RCPT TO:<${this._envelope.curRecipient}>`;
    if (this._capabilities.includes("DSN") && this._envelope.requestDSN) {
      let notify = [];
      if (Services.prefs.getBoolPref("mail.dsn.request_never_on")) {
        notify.push("NEVER");
      } else {
        if (Services.prefs.getBoolPref("mail.dsn.request_on_success_on")) {
          notify.push("SUCCESS");
        }
        if (Services.prefs.getBoolPref("mail.dsn.request_on_failure_on")) {
          notify.push("FAILURE");
        }
        if (Services.prefs.getBoolPref("mail.dsn.request_on_delay_on")) {
          notify.push("DELAY");
        }
      }
      if (notify.length > 0) {
        cmd += ` NOTIFY=${notify.join(",")}`;
      }
    }
    this._sendCommand(cmd);
  }

  /**
   * Response to a RCPT TO command. If the command is unsuccessful, try the next one,
   * as this might be related only to the current recipient, not a global error, so
   * the following recipients might still be valid
   *
   * @param {Object} command Parsed command from the server {statusCode, data}
   */
  _actionRCPT(command) {
    if (!command.success) {
      this.logger.warn("RCPT TO failed for: " + this._envelope.curRecipient);
      // this is a soft error
      this._envelope.rcptFailed.push(this._envelope.curRecipient);
    } else {
      this._envelope.responseQueue.push(this._envelope.curRecipient);
    }

    if (!this._envelope.rcptQueue.length) {
      if (this._envelope.rcptFailed.length < this._envelope.to.length) {
        this._currentAction = this._actionDATA;
        this.logger.debug("RCPT TO done, proceeding with payload");
        this._sendCommand("DATA");
      } else {
        this.logger.error("Can't send mail - all recipients were rejected");
        this._onNsError(MsgUtils.NS_ERROR_SENDING_RCPT_COMMAND, command.data);
        this._currentAction = this._actionIdle;
      }
    } else {
      this.logger.debug("Adding recipient...");
      this._envelope.curRecipient = this._envelope.rcptQueue.shift();
      this._currentAction = this._actionRCPT;
      this._sendCommand(`RCPT TO:<${this._envelope.curRecipient}>`);
    }
  }

  /**
   * Response to the DATA command. Server is now waiting for a message, so emit `onready`
   *
   * @param {Object} command Parsed command from the server {statusCode, data}
   */
  _actionDATA(command) {
    // response should be 354 but according to this issue https://github.com/eleith/emailjs/issues/24
    // some servers might use 250 instead
    if (![250, 354].includes(command.statusCode)) {
      this._onNsError(MsgUtils.NS_ERROR_SENDING_DATA_COMMAND, command.data);
      return;
    }

    this._dataMode = true;
    this._currentAction = this._actionIdle;
    this.onready(this._envelope.rcptFailed);
  }

  /**
   * Response from the server, once the message stream has ended with <CR><LF>.<CR><LF>
   * Emits `ondone`.
   *
   * @param {Object} command Parsed command from the server {statusCode, data}
   */
  _actionStream(command) {
    var rcpt;

    if (this.options.lmtp) {
      // LMTP returns a response code for *every* successfully set recipient
      // For every recipient the message might succeed or fail individually

      rcpt = this._envelope.responseQueue.shift();
      if (!command.success) {
        this.logger.error("Local delivery to " + rcpt + " failed.");
        this._envelope.rcptFailed.push(rcpt);
      } else {
        this.logger.error("Local delivery to " + rcpt + " succeeded.");
      }

      if (this._envelope.responseQueue.length) {
        this._currentAction = this._actionStream;
        return;
      }

      this._currentAction = this._actionIdle;
      this.ondone(0);
    } else {
      // For SMTP the message either fails or succeeds, there is no information
      // about individual recipients

      if (!command.success) {
        this.logger.error("Message sending failed.");
      } else {
        this.logger.debug("Message sent successfully.");
      }

      this._currentAction = this._actionIdle;
      this.ondone(command.success ? 0 : MsgUtils.NS_ERROR_SENDING_MESSAGE);
    }

    // If the client wanted to do something else (eg. to quit), do not force idle
    if (this._currentAction === this._actionIdle) {
      // Waiting for new connections
      this.logger.debug("Idling while waiting for new connections...");
      this.onidle();
    }
  }
}
