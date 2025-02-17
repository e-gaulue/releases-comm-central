/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const EXPORTED_SYMBOLS = ["MessageSend"];

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);

XPCOMUtils.defineLazyModuleGetters(this, {
  setTimeout: "resource://gre/modules/Timer.jsm",
  MailServices: "resource:///modules/MailServices.jsm",
  MailUtils: "resource:///modules/MailUtils.jsm",
  Services: "resource://gre/modules/Services.jsm",
  jsmime: "resource:///modules/jsmime.jsm",
  MimeMessage: "resource:///modules/MimeMessage.jsm",
  MsgUtils: "resource:///modules/MimeMessageUtils.jsm",
});

// nsMsgKey_None from MailNewsTypes.h.
const nsMsgKey_None = 0xffffffff;

/**
 * A module to manage sending processes.
 * Set `user_pref("mailnews.send.jsmodule", true);` to use this module.
 *
 * @implements {nsIMsgSend}
 */
function MessageSend() {}

MessageSend.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIMsgSend"]),
  classID: Components.ID("{028b9c1e-8d0a-4518-80c2-842e07846eaa}"),

  async createAndSendMessage(
    editor,
    userIdentity,
    accountKey,
    compFields,
    isDigest,
    dontDeliver,
    deliverMode,
    msgToReplace,
    bodyType,
    body,
    parentWindow,
    progress,
    listener,
    smtpPassword,
    originalMsgURI,
    compType
  ) {
    this._userIdentity = userIdentity;
    this._accountKey = accountKey;
    this._compFields = compFields;
    this._dontDeliver = dontDeliver;
    this._deliverMode = deliverMode;
    this._msgToReplace = msgToReplace;
    this._sendProgress = progress;
    this._smtpPassword = smtpPassword;
    this._sendListener = listener;
    this._parentWindow = parentWindow;
    this._originalMsgURI = originalMsgURI;
    this._shouldRemoveMessageFile = true;

    this._sendReport = Cc[
      "@mozilla.org/messengercompose/sendreport;1"
    ].createInstance(Ci.nsIMsgSendReport);
    this._composeBundle = Services.strings.createBundle(
      "chrome://messenger/locale/messengercompose/composeMsgs.properties"
    );

    // Initialize the error reporting mechanism.
    this.sendReport.reset();
    this.sendReport.deliveryMode = deliverMode;
    this._setStatusMessage(
      this._composeBundle.GetStringFromName("assemblingMailInformation")
    );
    this.sendReport.currentProcess = Ci.nsIMsgSendReport.process_BuildMessage;

    this._setStatusMessage(
      this._composeBundle.GetStringFromName("assemblingMessage")
    );

    this._fcc = MsgUtils.getFcc(
      userIdentity,
      compFields,
      originalMsgURI,
      compType
    );
    let {
      embeddedAttachments,
      embeddedObjects,
    } = this._gatherEmbeddedAttachments(editor);
    let bodyText = this._getBodyFromEditor(editor) || body;
    this._restoreEditorContent(embeddedObjects);
    this._message = new MimeMessage(
      userIdentity,
      compFields,
      this._fcc,
      bodyType,
      bodyText,
      deliverMode,
      originalMsgURI,
      compType,
      embeddedAttachments,
      this.sendReport
    );

    this._messageKey = nsMsgKey_None;

    this._setStatusMessage(
      this._composeBundle.GetStringFromName("creatingMailMessage")
    );
    MsgUtils.sendLogger.debug("Creating message file");
    let messageFile;
    try {
      // Create a local file from MimeMessage, then pass it to _deliverMessage.
      messageFile = await this._message.createMessageFile();
    } catch (e) {
      MsgUtils.sendLogger.error(e);
      let errorMsg = "";
      if (e.result == MsgUtils.NS_MSG_ERROR_ATTACHING_FILE) {
        errorMsg = this._composeBundle.formatStringFromName(
          "errorAttachingFile",
          [e.data.name || e.data.url]
        );
      }
      this.fail(e.result || Cr.NS_ERROR_FAILURE, errorMsg);
      this.notifyListenerOnStopSending(null, e.result, null, null);
      return null;
    }
    this._setStatusMessage(
      this._composeBundle.GetStringFromName("assemblingMessageDone")
    );
    MsgUtils.sendLogger.debug("Message file created");
    return this._deliverMessage(messageFile);
  },

  sendMessageFile(
    userIdentity,
    accountKey,
    compFields,
    messageFile,
    deleteSendFileOnCompletion,
    digest,
    deliverMode,
    msgToReplace,
    listener,
    statusFeedback,
    smtpPassword
  ) {
    this._userIdentity = userIdentity;
    this._accountKey = accountKey;
    this._compFields = compFields;
    this._deliverMode = deliverMode;
    this._msgToReplace = msgToReplace;
    this._smtpPassword = smtpPassword;
    this._sendListener = listener;
    this._statusFeedback = statusFeedback;
    this._shouldRemoveMessageFile = deleteSendFileOnCompletion;

    this._sendReport = Cc[
      "@mozilla.org/messengercompose/sendreport;1"
    ].createInstance(Ci.nsIMsgSendReport);
    this._composeBundle = Services.strings.createBundle(
      "chrome://messenger/locale/messengercompose/composeMsgs.properties"
    );

    // Initialize the error reporting mechanism.
    this.sendReport.reset();
    this.sendReport.deliveryMode = deliverMode;
    this._setStatusMessage(
      this._composeBundle.GetStringFromName("assemblingMailInformation")
    );
    this.sendReport.currentProcess = Ci.nsIMsgSendReport.process_BuildMessage;

    this._setStatusMessage(
      this._composeBundle.GetStringFromName("assemblingMessage")
    );

    this._fcc = MsgUtils.getFcc(
      userIdentity,
      compFields,
      null,
      Ci.nsIMsgCompType.New
    );

    // nsMsgKey_None from MailNewsTypes.h.
    this._messageKey = 0xffffffff;

    return this._deliverMessage(messageFile);
  },

  // @see nsIMsgSend
  createRFC822Message(
    userIdentity,
    compFields,
    bodyType,
    bodyText,
    isDraft,
    attachedFiles,
    embeddedObjects,
    listener
  ) {
    this._userIdentity = userIdentity;
    this._compFields = compFields;
    this._dontDeliver = true;
    this._sendListener = listener;

    this._sendReport = Cc[
      "@mozilla.org/messengercompose/sendreport;1"
    ].createInstance(Ci.nsIMsgSendReport);
    this._composeBundle = Services.strings.createBundle(
      "chrome://messenger/locale/messengercompose/composeMsgs.properties"
    );

    // Initialize the error reporting mechanism.
    this.sendReport.reset();
    let deliverMode = isDraft
      ? Ci.nsIMsgSend.nsMsgSaveAsDraft
      : Ci.nsIMsgSend.nsMsgDeliverNow;
    this.sendReport.deliveryMode = deliverMode;

    // Convert nsIMsgAttachedFile[] to nsIMsgAttachment[]
    for (let file of attachedFiles) {
      let attachment = Cc[
        "@mozilla.org/messengercompose/attachment;1"
      ].createInstance(Ci.nsIMsgAttachment);
      attachment.name = file.realName;
      attachment.url = file.origUrl.spec;
      attachment.contentType = file.type;
      compFields.addAttachment(attachment);
    }

    // Convert nsIMsgEmbeddedImageData[] to nsIMsgAttachment[]
    let embeddedAttachments = embeddedObjects.map(obj => {
      let attachment = Cc[
        "@mozilla.org/messengercompose/attachment;1"
      ].createInstance(Ci.nsIMsgAttachment);
      attachment.name = obj.name;
      attachment.contentId = obj.cid;
      attachment.url = obj.uri.spec;
      return attachment;
    });

    this._message = new MimeMessage(
      userIdentity,
      compFields,
      null,
      bodyType,
      bodyText,
      deliverMode,
      null,
      Ci.nsIMsgCompType.New,
      embeddedAttachments,
      this.sendReport
    );

    this._messageKey = nsMsgKey_None;

    // Create a local file from MimeMessage, then pass it to _deliverMessage.
    this._message
      .createMessageFile()
      .then(messageFile => this._deliverMessage(messageFile));
  },

  abort() {
    if (this._aborting) {
      return;
    }
    this._aborting = true;
    if (this._smtpRequest?.value) {
      this._smtpRequest.value.cancel(Cr.NS_ERROR_ABORT);
      this._smtpRequest = null;
    }
    if (this._msgCopy) {
      MailServices.copy.NotifyCompletion(
        this._copyFile,
        this._msgCopy.dstFolder,
        Cr.NS_ERROR_ABORT
      );
    }
    if (!this._failed) {
      // Emit stopsending event if the sending is cancelled by user, so that
      // listeners can do necessary clean up, e.g. reset the sending button.
      this.notifyListenerOnStopSending(null, Cr.NS_ERROR_ABORT, null, null);
    }
    this._cleanup();
    this._aborting = false;
  },

  getDefaultPrompt() {
    if (this._parentWindow) {
      let prompter = Cc["@mozilla.org/prompter;1"].getService(
        Ci.nsIPromptFactory
      );
      try {
        return prompter.getPrompt(this._parentWindow, Ci.nsIPrompt);
      } catch (e) {}
    }
    // If we cannot find a prompter, try the mail3Pane window.
    let prompt;
    try {
      prompt = MailServices.mailSession.topmostMsgWindow.promptDialog;
    } catch (e) {
      console.warn(
        `topmostMsgWindow.promptDialog failed with 0x${e.result.toString(
          16
        )}\n${e.stack}`
      );
    }
    return prompt;
  },

  fail(exitCode, errorMsg) {
    this._failed = true;
    let prompt = this.getDefaultPrompt();
    if (!Components.isSuccessCode(exitCode) && prompt) {
      MsgUtils.sendLogger.error(
        `Sending failed; ${errorMsg}, exitCode=${exitCode}, originalMsgURI=${this._originalMsgURI}`
      );
      this._sendReport.setError(
        Ci.nsIMsgSendReport.process_Current,
        exitCode,
        false
      );
      if (errorMsg) {
        this._sendReport.setMessage(
          Ci.nsIMsgSendReport.process_Current,
          errorMsg,
          false
        );
      }
      exitCode = this._sendReport.displayReport(prompt, true, true);
    }
    this.abort();

    return exitCode;
  },

  getPartForDomIndex(domIndex) {
    throw Components.Exception(
      "getPartForDomIndex not implemented",
      Cr.NS_ERROR_NOT_IMPLEMENTED
    );
  },

  getProgress() {
    return this._sendProgress;
  },

  /**
   * NOTE: This is a copy of the C++ code, msgId and msgSize are only
   * placeholders. Maybe refactor this after nsMsgSend is gone.
   */
  notifyListenerOnStartSending(msgId, msgSize) {
    MsgUtils.sendLogger.debug("notifyListenerOnStartSending");
    if (this._sendListener) {
      this._sendListener.onStartSending(msgId, msgSize);
    }
  },

  notifyListenerOnStartCopy() {
    MsgUtils.sendLogger.debug("notifyListenerOnStartCopy");
    if (this._sendListener) {
      this._sendListener
        .QueryInterface(Ci.nsIMsgCopyServiceListener)
        .OnStartCopy();
    }
  },

  notifyListenerOnProgressCopy(progress, progressMax) {
    MsgUtils.sendLogger.debug("notifyListenerOnProgressCopy");
    if (this._sendListener) {
      this._sendListener
        .QueryInterface(Ci.nsIMsgCopyServiceListener)
        .OnProgress(progress, progressMax);
    }
  },

  notifyListenerOnStopCopy(status) {
    MsgUtils.sendLogger.debug(`notifyListenerOnStopCopy; status=${status}`);
    this._msgCopy = null;

    let statusMsgEntry = Components.isSuccessCode(status)
      ? "copyMessageComplete"
      : "copyMessageFailed";
    this._setStatusMessage(
      this._composeBundle.GetStringFromName(statusMsgEntry)
    );

    if (!Components.isSuccessCode(status)) {
      let localFoldersAccountName =
        MailServices.accounts.localFoldersServer.prettyName;
      let folder = MailUtils.getOrCreateFolder(this._folderUri);
      let accountName = folder?.server.prettyName;
      if (!this._fcc || !localFoldersAccountName || !accountName) {
        this.fail(Cr.NS_OK, null);
        return;
      }

      let params = [folder.name, accountName, localFoldersAccountName];
      let promptMsg;
      switch (this._deliverMode) {
        case Ci.nsIMsgSend.nsMsgDeliverNow:
        case Ci.nsIMsgSend.nsMsgSendUnsent:
          promptMsg = this._composeBundle.formatStringFromName(
            "promptToSaveSentLocally2",
            params
          );
          break;
        case Ci.nsIMsgSend.nsMsgSaveAsDraft:
          promptMsg = this._composeBundle.formatStringFromName(
            "promptToSaveDraftLocally2",
            params
          );
          break;
        case Ci.nsIMsgSend.nsMsgSaveAsTemplate:
          promptMsg = this._composeBundle.formatStringFromName(
            "promptToSaveTemplateLocally2",
            params
          );
          break;
      }
      if (promptMsg) {
        let showCheckBox = { value: false };
        let buttonFlags =
          Ci.nsIPrompt.BUTTON_POS_0 * Ci.nsIPrompt.BUTTON_TITLE_IS_STRING +
          Ci.nsIPrompt.BUTTON_POS_1 * Ci.nsIPrompt.BUTTON_TITLE_DONT_SAVE +
          Ci.nsIPrompt.BUTTON_POS_2 * Ci.nsIPrompt.BUTTON_TITLE_SAVE;
        let dialogTitle = this._composeBundle.GetStringFromName(
          "SaveDialogTitle"
        );
        let buttonLabelRety = this._composeBundle.GetStringFromName(
          "buttonLabelRetry2"
        );
        let prompt = this.getDefaultPrompt();
        let buttonPressed = prompt.confirmEx(
          dialogTitle,
          promptMsg,
          buttonFlags,
          buttonLabelRety,
          null,
          null,
          null,
          showCheckBox
        );
        if (buttonPressed == 0) {
          // retry button clicked
          this._mimeDoFcc();
          return;
        } else if (buttonPressed == 2) {
          try {
            // Try to save to Local Folders/<account name>. Pass null to save
            // to local folders and not the configured fcc.
            this._mimeDoFcc(null, true, Ci.nsIMsgSend.nsMsgDeliverNow);
            return;
          } catch (e) {
            prompt.alert(
              null,
              this._composeBundle.GetStringFromName("saveToLocalFoldersFailed")
            );
          }
        }
      }
      this.fail(Cr.NS_OK, null);
    }

    if (
      !this._fcc2Handled &&
      this._messageKey != nsMsgKey_None &&
      [Ci.nsIMsgSend.nsMsgDeliverNow, Ci.nsIMsgSend.nsMsgSendUnsent].includes(
        this._deliverMode
      )
    ) {
      try {
        this._filterSentMessage();
      } catch (e) {
        this.onStopOperation(e.result);
      }
      return;
    }

    this._doFcc2();
  },

  notifyListenerOnStopSending(msgId, status, msg, returnFile) {
    MsgUtils.sendLogger.debug(`notifyListenerOnStopSending; status=${status}`);
    try {
      this._sendListener?.onStopSending(msgId, status, msg, returnFile);
    } catch (e) {}
  },

  notifyListenerOnTransportSecurityError(msgId, status, secInfo, location) {
    MsgUtils.sendLogger.debug(
      `notifyListenerOnTransportSecurityError; status=${status}, location=${location}`
    );
    if (!this._sendListener) {
      return;
    }
    try {
      this._sendListener.onTransportSecurityError(
        msgId,
        status,
        secInfo,
        location
      );
    } catch (e) {}
  },

  /**
   * Called by nsIMsgFilterService.
   */
  onStopOperation(status) {
    MsgUtils.sendLogger.debug(`onStopOperation; status=${status}`);
    if (Components.isSuccessCode(status)) {
      this._setStatusMessage(
        this._composeBundle.GetStringFromName("filterMessageComplete")
      );
    } else {
      this._setStatusMessage(
        this._composeBundle.GetStringFromName("filterMessageFailed")
      );
      this.getDefaultPrompt().alert(
        null,
        this._composeBundle.GetStringFromName("errorFilteringMsg")
      );
    }

    this._doFcc2();
  },

  /**
   * Handle the exit code of message delivery.
   * @param {nsIURI} url - The delivered message uri.
   * @param {boolean} isNewsDelivery - The message was delivered to newsgroup.
   * @param {nsreault} exitCode - The exit code of message delivery.
   */
  _deliveryExitProcessing(url, isNewsDelivery, exitCode) {
    MsgUtils.sendLogger.debug(`Delivery exit processing; exitCode=${exitCode}`);
    if (!Components.isSuccessCode(exitCode)) {
      let isNSSError = false;
      let errorName = MsgUtils.getErrorStringName(exitCode);
      let errorMsg;
      if (
        [
          MsgUtils.NS_ERROR_SMTP_SEND_FAILED_UNKNOWN_SERVER,
          MsgUtils.NS_ERROR_SMTP_SEND_FAILED_REFUSED,
          MsgUtils.NS_ERROR_SMTP_SEND_FAILED_INTERRUPTED,
          MsgUtils.NS_ERROR_SMTP_SEND_FAILED_TIMEOUT,
          MsgUtils.NS_ERROR_SMTP_PASSWORD_UNDEFINED,
          MsgUtils.NS_ERROR_SMTP_AUTH_FAILURE,
          MsgUtils.NS_ERROR_SMTP_AUTH_GSSAPI,
          MsgUtils.NS_ERROR_SMTP_AUTH_MECH_NOT_SUPPORTED,
          MsgUtils.NS_ERROR_SMTP_AUTH_CHANGE_ENCRYPT_TO_PLAIN_NO_SSL,
          MsgUtils.NS_ERROR_SMTP_AUTH_CHANGE_ENCRYPT_TO_PLAIN_SSL,
          MsgUtils.NS_ERROR_SMTP_AUTH_CHANGE_PLAIN_TO_ENCRYPT,
          MsgUtils.NS_ERROR_STARTTLS_FAILED_EHLO_STARTTLS,
        ].includes(exitCode)
      ) {
        errorMsg = MsgUtils.formatStringWithSMTPHostName(
          this._userIdentity,
          this._composeBundle,
          errorName
        );
      } else {
        let nssErrorsService = Cc[
          "@mozilla.org/nss_errors_service;1"
        ].getService(Ci.nsINSSErrorsService);
        try {
          // This is a server security issue as determined by the Mozilla
          // platform. To the Mozilla security message string, appended a string
          // having additional information with the server name encoded.
          errorMsg = nssErrorsService.getErrorMessage(exitCode);
          errorMsg +=
            "\n" +
            MsgUtils.formatStringWithSMTPHostName(
              this._userIdentity,
              this._composeBundle,
              "smtpSecurityIssue"
            );
          isNSSError = true;
        } catch (e) {
          if (errorName == "sendFailed") {
            // Not the default string. A mailnews error occurred that does not
            // require the server name to be encoded. Just print the descriptive
            // string.
            errorMsg = this._composeBundle.GetStringFromName(errorName);
          } else if (url.errorMessage) {
            // url.errorMessage is an already localized message, usually
            // combined with the error message from SMTP server.
            errorMsg = url.errorMessage;
          } else {
            errorMsg = this._composeBundle.GetStringFromName(
              "sendFailedUnexpected"
            );
            // nsIStringBundle.formatStringFromName doesn't work with %X.
            errorMsg.replace("%X", `0x${exitCode.toString(16)}`);
            errorMsg =
              "\n" +
              MsgUtils.formatStringWithSMTPHostName(
                this._userIdentity,
                this._composeBundle,
                "smtpSendFailedUnknownReason"
              );
          }
        }
      }
      this.fail(exitCode, errorMsg);
      if (isNSSError) {
        let u = url.QueryInterface(Ci.nsIMsgMailNewsUrl);
        this.notifyListenerOnTransportSecurityError(
          null,
          exitCode,
          u.failedSecInfo,
          u.asciiHostPort
        );
      }
      this.notifyListenerOnStopSending(null, exitCode, null, null);
      return;
    }

    if (
      isNewsDelivery &&
      (this._compFields.to || this._compFields.cc || this._compFields.bcc)
    ) {
      this._deliverFileAsMail();
      return;
    }

    this.notifyListenerOnStopSending(
      this._compFields.messageId,
      exitCode,
      null,
      null
    );

    this._doFcc();
  },

  sendDeliveryCallback(url, isNewsDelivery, exitCode) {
    if (isNewsDelivery) {
      if (
        !Components.isSuccessCode(exitCode) &&
        exitCode != Cr.NS_ERROR_ABORT &&
        !MsgUtils.isMsgError(exitCode)
      ) {
        exitCode = MsgUtils.NS_ERROR_POST_FAILED;
      }
      return this._deliveryExitProcessing(url, isNewsDelivery, exitCode);
    }
    if (!Components.isSuccessCode(exitCode)) {
      switch (exitCode) {
        case Cr.NS_ERROR_UNKNOWN_HOST:
        case Cr.NS_ERROR_UNKNOWN_PROXY_HOST:
          exitCode = MsgUtils.NS_ERROR_SMTP_SEND_FAILED_UNKNOWN_SERVER;
          break;
        case Cr.NS_ERROR_CONNECTION_REFUSED:
        case Cr.NS_ERROR_PROXY_CONNECTION_REFUSED:
          exitCode = MsgUtils.NS_ERROR_SMTP_SEND_FAILED_REFUSED;
          break;
        case Cr.NS_ERROR_NET_INTERRUPT:
        case Cr.NS_ERROR_ABORT:
          exitCode = MsgUtils.NS_ERROR_SMTP_SEND_FAILED_INTERRUPTED;
          break;
        case Cr.NS_ERROR_NET_TIMEOUT:
        case Cr.NS_ERROR_NET_RESET:
          exitCode = MsgUtils.NS_ERROR_SMTP_SEND_FAILED_TIMEOUT;
          break;
        default:
          break;
      }
    }
    return this._deliveryExitProcessing(url, isNewsDelivery, exitCode);
  },

  get folderUri() {
    return this._folderUri;
  },

  /**
   * @type {nsMsgKey}
   */
  set messageKey(key) {
    this._messageKey = key;
  },

  /**
   * @type {nsMsgKey}
   */
  get messageKey() {
    return this._messageKey;
  },

  get sendReport() {
    return this._sendReport;
  },

  _setStatusMessage(msg) {
    if (this._sendProgress) {
      this._sendProgress.onStatusChange(null, null, Cr.NS_OK, msg);
    }
  },

  /**
   * Deliver a message.
   *
   * @param {nsIFile} file - The message file to deliver.
   */
  async _deliverMessage(file) {
    if (this._dontDeliver) {
      this.notifyListenerOnStopSending(null, Cr.NS_OK, null, file);
      return;
    }

    this._messageFile = file;
    if (
      [
        Ci.nsIMsgSend.nsMsgQueueForLater,
        Ci.nsIMsgSend.nsMsgDeliverBackground,
        Ci.nsIMsgSend.nsMsgSaveAsDraft,
        Ci.nsIMsgSend.nsMsgSaveAsTemplate,
      ].includes(this._deliverMode)
    ) {
      await this._mimeDoFcc();
      return;
    }

    let warningSize = Services.prefs.getIntPref(
      "mailnews.message_warning_size"
    );
    if (warningSize > 0 && file.fileSize > warningSize) {
      let messenger = Cc["@mozilla.org/messenger;1"].createInstance(
        Ci.nsIMessenger
      );
      let msg = this._composeBundle.formatStringFromName(
        "largeMessageSendWarning",
        [messenger.formatFileSize(file.fileSize)]
      );
      let prompt = this.getDefaultPrompt();
      if (!prompt.confirm(null, msg)) {
        this.fail(MsgUtils.NS_ERROR_BUT_DONT_SHOW_ALERT, msg);
        throw Components.Exception(
          "Cancelled sending large message",
          Cr.NS_ERROR_FAILURE
        );
      }
    }

    this._deliveryFile = await this._createDeliveryFile();
    if (this._compFields.newsgroups) {
      this._deliverFileAsNews(this._deliveryFile);
      return;
    }
    this._deliverFileAsMail(this._deliveryFile);
  },

  /**
   * Strip Bcc header, create the file to be actually delivered.
   * @returns {nsIFile}
   */
  async _createDeliveryFile() {
    if (!this._compFields.bcc) {
      return this._messageFile;
    }
    let deliveryFile = Services.dirsvc.get("TmpD", Ci.nsIFile);
    deliveryFile.append("nsemail.tmp");
    deliveryFile.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
    let content = await IOUtils.read(this._messageFile.path);
    let bodyIndex = content.findIndex(
      (el, index) =>
        // header and body are separated by \r\n\r\n
        el == 13 &&
        content[index + 1] == 10 &&
        content[index + 2] == 13 &&
        content[index + 3] == 10
    );
    let header = new TextDecoder("UTF-8").decode(content.slice(0, bodyIndex));
    let lastLinePruned = false;
    let headerToWrite = "";
    for (let line of header.split("\r\n")) {
      if (line.startsWith("Bcc") || (line.startsWith(" ") && lastLinePruned)) {
        lastLinePruned = true;
        continue;
      }
      lastLinePruned = false;
      headerToWrite += `${line}\r\n`;
    }
    let encodedHeader = new TextEncoder().encode(headerToWrite);
    // Prevent extra \r\n, which was already added to the last head line.
    let body = content.slice(bodyIndex + 2);
    let combinedContent = new Uint8Array(encodedHeader.length + body.length);
    combinedContent.set(encodedHeader);
    combinedContent.set(body, encodedHeader.length);
    await IOUtils.write(deliveryFile.path, combinedContent);
    return deliveryFile;
  },

  /**
   * Start copy operation according to this._fcc value.
   */
  async _doFcc() {
    if (!this._fcc || !MsgUtils.canSaveToFolder(this._fcc)) {
      this.notifyListenerOnStopCopy(Cr.NS_OK);
      return;
    }
    this.sendReport.currentProcess = Ci.nsIMsgSendReport.process_Copy;
    this._mimeDoFcc(this._fcc, false, Ci.nsIMsgSend.nsMsgDeliverNow);
  },

  /**
   * Copy a message to a folder, or fallback to a folder depending on pref and
   * deliverMode, usually Drafts/Sent.
   * @param {string} [fccHeader=this._fcc] - The target folder uri to copy the
   * message to.
   * @param {boolean} [throwOnError=false] - By default notifyListenerOnStopCopy
   * is called on error. When throwOnError is true, the caller can handle the
   * error by itself.
   * @param {nsMsgDeliverMode} [deliverMode=this._deliverMode] - The deliver mode.
   */
  async _mimeDoFcc(
    fccHeader = this._fcc,
    throwOnError = false,
    deliverMode = this._deliverMode
  ) {
    let folder;
    let folderUri;
    if (fccHeader) {
      folder = MailUtils.getExistingFolder(fccHeader);
    }
    if (
      [Ci.nsIMsgSend.nsMsgDeliverNow, Ci.nsIMsgSend.nsMsgSendUnsent].includes(
        deliverMode
      ) &&
      folder
    ) {
      this._folderUri = fccHeader;
    } else if (fccHeader == null) {
      // Set fcc_header to a special folder in Local Folders "account" since can't
      // save to Sent mbox, typically because imap connection is down. This
      // folder is created if it doesn't yet exist.
      let rootFolder = MailServices.accounts.localFoldersServer.rootMsgFolder;
      folderUri = rootFolder.URI + "/";

      // Now append the special folder name folder to the local folder uri.
      if (
        [
          Ci.nsIMsgSend.nsMsgDeliverNow,
          Ci.nsIMsgSend.nsMsgSendUnsent,
          Ci.nsIMsgSend.nsMsgSaveAsDraft,
          Ci.nsIMsgSend.nsMsgSaveAsTemplate,
        ].includes(this._deliverMode)
      ) {
        // Typically, this appends "Sent-", "Drafts-" or "Templates-" to folder
        // and then has the account name appended, e.g., .../Sent-MyImapAccount.
        let folder = MailUtils.getOrCreateFolder(this._folderUri);
        folderUri += folder.name + "-";
      }
      if (this._fcc) {
        // Get the account name where the "save to" failed.
        let accountName = MailUtils.getOrCreateFolder(this._fcc).server
          .prettyName;

        // Now append the imap account name (escaped) to the folder uri.
        folderUri += accountName;
        this._folderUri = folderUri;
      }
    } else {
      this._folderUri = MsgUtils.getMsgFolderURIFromPrefs(
        this._userIdentity,
        this._deliverMode
      );
    }
    MsgUtils.sendLogger.debug(`Processing fcc; folderUri=${this._folderUri}`);

    this._msgCopy = Cc[
      "@mozilla.org/messengercompose/msgcopy;1"
    ].createInstance(Ci.nsIMsgCopy);
    this._copyFile = this._messageFile;
    if (this._folderUri.startsWith("mailbox:")) {
      this._copyFile = Services.dirsvc.get("TmpD", Ci.nsIFile);
      this._copyFile.append("nscopy.tmp");
      this._copyFile.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
      let contentToWrite = "";
      // Add a `From - Date` line, so that nsLocalMailFolder.cpp won't add a
      // dummy envelope. The date string will be parsed by PR_ParseTimeString.
      // TODO: this should not be added to Maildir, see bug 1686852.
      contentToWrite += `From - ${new Date().toUTCString()}\r\n`;
      let xMozillaStatus = MsgUtils.getXMozillaStatus(this._deliverMode);
      let xMozillaStatus2 = MsgUtils.getXMozillaStatus2(this._deliverMode);
      if (xMozillaStatus) {
        contentToWrite += `X-Mozilla-Status: ${xMozillaStatus}\r\n`;
      }
      if (xMozillaStatus2) {
        contentToWrite += `X-Mozilla-Status2: ${xMozillaStatus2}\r\n`;
      }
      const encodedContent = new TextEncoder().encode(contentToWrite);
      const messageFileContent = await IOUtils.read(this._messageFile.path);
      const combinedContent = new Uint8Array(
        encodedContent.length + messageFileContent.length
      );
      combinedContent.set(encodedContent);
      combinedContent.set(messageFileContent, encodedContent.length);
      await IOUtils.write(this._copyFile.path, combinedContent);
    }
    MsgUtils.sendLogger.debug("fcc file created");

    // Notify nsMsgCompose about the saved folder.
    if (this._sendListener) {
      this._sendListener.onGetDraftFolderURI(this._folderUri);
    }
    folder = MailUtils.getOrCreateFolder(this._folderUri);
    let statusMsg = this._composeBundle.formatStringFromName(
      "copyMessageStart",
      [folder?.name || "?"]
    );
    this._setStatusMessage(statusMsg);
    MsgUtils.sendLogger.debug("startCopyOperation");
    try {
      this._msgCopy.startCopyOperation(
        this._userIdentity,
        this._copyFile,
        this._deliverMode,
        this,
        this._folderUri,
        this._msgToReplace
      );
    } catch (e) {
      MsgUtils.sendLogger.warn(`startCopyOperation failed with ${e.result}`);
      if (throwOnError) {
        throw Components.Exception("startCopyOperation failed", e.result);
      }
      this.notifyListenerOnStopCopy(e.result);
    }
  },

  /**
   * Handle the fcc2 field. Then notify OnStopCopy and clean up.
   */
  _doFcc2() {
    // Handle fcc2 only once.
    if (!this._fcc2Handled && this._compFields.fcc2) {
      MsgUtils.sendLogger.debug("Processing fcc2");
      this._fcc2Handled = true;
      this._mimeDoFcc(
        this._compFields.fcc2,
        false,
        Ci.nsIMsgSend.nsMsgDeliverNow
      );
      return;
    }

    // NOTE: When nsMsgCompose receives OnStopCopy, it will release nsIMsgSend
    // instance and close the compose window, which prevents the Promise from
    // resolving in MsgComposeCommands.js. Use setTimeout to work around it.
    setTimeout(() => {
      try {
        this._sendListener
          ?.QueryInterface(Ci.nsIMsgCopyServiceListener)
          .OnStopCopy(0);
      } catch (e) {
        // Ignore the return value of OnStopCopy. Non-zero nsresult will throw
        // when going through XPConnect. In this case, we don't care about it.
        console.warn(
          `OnStopCopy failed with 0x${e.result.toString(16)}\n${e.stack}`
        );
      }
    });
    this._cleanup();
  },

  /**
   * Run filters on the just sent message.
   */
  _filterSentMessage() {
    this.sendReport.currentProcess = Ci.nsIMsgSendReport.process_Filter;
    let folder = MailUtils.getExistingFolder(this._folderUri);
    let msgHdr = folder.GetMessageHeader(this._messageKey);
    let msgWindow = this._sendProgress?.msgWindow;
    return MailServices.filters.applyFilters(
      Ci.nsMsgFilterType.PostOutgoing,
      [msgHdr],
      folder,
      msgWindow,
      this
    );
  },

  _cleanup() {
    MsgUtils.sendLogger.debug("Clean up temporary files");
    if (this._copyFile && this._copyFile != this._messageFile) {
      IOUtils.remove(this._copyFile.path).catch(Cu.reportError);
      this._copyFile = null;
    }
    if (this._deliveryFile && this._deliveryFile != this._messageFile) {
      IOUtils.remove(this._deliveryFile.path).catch(Cu.reportError);
      this._deliveryFile = null;
    }
    if (this._messageFile && this._shouldRemoveMessageFile) {
      IOUtils.remove(this._messageFile.path).catch(Cu.reportError);
      this._messageFile = null;
    }
  },

  /**
   * Send a file to smtp service.
   * @param {nsIFile} file - The file to send.
   */
  _deliverFileAsMail(file) {
    this.sendReport.currentProcess = Ci.nsIMsgSendReport.process_SMTP;
    this._setStatusMessage(
      this._composeBundle.GetStringFromName("sendingMessage")
    );
    let recipients = [
      this._compFields.to,
      this._compFields.cc,
      this._compFields.bcc,
    ].filter(Boolean);
    this._collectAddressesToAddressBook(recipients);
    let converter = Cc["@mozilla.org/messenger/mimeconverter;1"].getService(
      Ci.nsIMimeConverter
    );
    let encodedRecipients = encodeURIComponent(
      converter.encodeMimePartIIStr_UTF8(
        recipients.join(","),
        true,
        0,
        Ci.nsIMimeConverter.MIME_ENCODED_WORD_SIZE
      )
    );
    MsgUtils.sendLogger.debug("Delivering mail message");
    let deliveryListener = new MsgDeliveryListener(this, false);
    let msgStatus =
      this._sendProgress?.QueryInterface(Ci.nsIMsgStatusFeedback) ||
      this._statusFeedback;
    this._smtpRequest = {};
    MailServices.smtp.sendMailMessage(
      file,
      encodedRecipients,
      this._userIdentity,
      this._compFields.from,
      this._smtpPassword,
      deliveryListener,
      msgStatus,
      null,
      this._compFields.DSN,
      this._compFields.messageId,
      {},
      this._smtpRequest
    );
  },

  /**
   * Send a file to nntp service.
   * @param {nsIFile} file - The file to send.
   */
  _deliverFileAsNews(file) {
    this.sendReport.currentProcess = Ci.nsIMsgSendReport.process_NNTP;
    MsgUtils.sendLogger.debug("Delivering news message");
    let deliveryListener = new MsgDeliveryListener(this, true);
    let msgWindow =
      this._sendProgress?.msgWindow ||
      MailServices.mailSession.topmostMsgWindow;
    MailServices.nntp.postMessage(
      file,
      this._compFields.newsgroups,
      this._accountKey,
      deliveryListener,
      msgWindow,
      null
    );
  },

  /**
   * Collect outgoing addresses to address book.
   * @param {string[]} recipients - Outgoing addresses including to/cc/bcc.
   */
  _collectAddressesToAddressBook(recipients) {
    let createCard = Services.prefs.getBoolPref(
      "mail.collect_email_address_outgoing",
      false
    );
    let sendFormat = Ci.nsIAbPreferMailFormat.unknown;

    let addressCollector = Cc[
      "@mozilla.org/addressbook/services/addressCollector;1"
    ].getService(Ci.nsIAbAddressCollector);
    for (let recipient of recipients) {
      addressCollector.collectAddress(recipient, createCard, sendFormat);
    }
  },

  /**
   * Check if link text is equivalent to the href.
   * @param {string} text - The innerHTML of a <a> element.
   * @param {string} href - The href of a <a> element.
   * @returns {boolean} true if text is equivalent to href.
   */
  _isLinkFreeText(text, href) {
    href = href.trim();
    if (href.startsWith("mailto:")) {
      return this._isLinkFreeText(text, href.slice("mailto:".length));
    }
    text = text.trim();
    return (
      text == href ||
      (text.endsWith("/") && text.slice(0, -1) == href) ||
      (href.endsWith("/") && href.slice(0, -1) == text)
    );
  },

  /**
   * Collect embedded objects as attachments.
   * @returns {{embeddedAttachments: nsIMsgAttachment[], embeddedObjects: []}}
   */
  _gatherEmbeddedAttachments(editor) {
    let embeddedAttachments = [];
    let embeddedObjects = [];

    if (!editor || !editor.document) {
      return { embeddedAttachments, embeddedObjects };
    }
    let nodes = [];
    nodes.push(...editor.document.querySelectorAll("img"));
    nodes.push(...editor.document.querySelectorAll("a"));
    let body = editor.document.querySelector("body[background]");
    if (body) {
      nodes.push(body);
    }

    let urlCidCache = {};
    for (let element of nodes) {
      if (element.tagName == "A" && element.href) {
        if (this._isLinkFreeText(element.innerHTML, element.href)) {
          // Set this special classname, which is recognized by nsIParserUtils,
          // so that links are not duplicated in text/plain.
          element.classList.add("moz-txt-link-freetext");
        }
      }
      let isImage = false;
      let url;
      let name;
      let mozDoNotSend = element.getAttribute("moz-do-not-send");
      if (mozDoNotSend && mozDoNotSend.toLowerCase() != "false") {
        // Only empty or moz-do-not-send="false" may be accepted later.
        continue;
      }
      if (element.tagName == "BODY" && element.background) {
        isImage = true;
        url = element.background;
      } else if (element.tagName == "IMG" && element.src) {
        isImage = true;
        url = element.src;
        name = element.name;
      } else if (element.tagName == "A" && element.href) {
        url = element.href;
        name = element.name;
      } else {
        continue;
      }
      let acceptObject = false;
      // Before going further, check what scheme we're dealing with. Files need to
      // be converted to data URLs during composition. "Attaching" means
      // sending as a cid: part instead of original URL.
      if (/^https?:\/\//i.test(url)) {
        acceptObject =
          isImage &&
          Services.prefs.getBoolPref("mail.compose.attach_http_images", false);
      }
      if (/^(data|news|snews|nntp):/i.test(url)) {
        acceptObject = true;
      }
      if (!acceptObject) {
        continue;
      }

      let cid;
      if (urlCidCache[url]) {
        // If an url has already been inserted as MimePart, just reuse the cid.
        cid = urlCidCache[url];
      } else {
        cid = MsgUtils.makeContentId(
          this._userIdentity,
          embeddedAttachments.length + 1
        );
        urlCidCache[url] = cid;

        let attachment = Cc[
          "@mozilla.org/messengercompose/attachment;1"
        ].createInstance(Ci.nsIMsgAttachment);
        attachment.name = name || MsgUtils.pickFileNameFromUrl(url);
        attachment.contentId = cid;
        attachment.url = url;
        embeddedAttachments.push(attachment);
      }
      embeddedObjects.push({
        element,
        url,
      });

      let newUrl = `cid:${cid}`;
      if (element.tagName == "BODY") {
        element.background = newUrl;
      } else if (element.tagName == "IMG") {
        element.src = newUrl;
      } else if (element.tagName == "A") {
        element.href = newUrl;
      }
    }
    return { embeddedAttachments, embeddedObjects };
  },

  /**
   * Restore embedded objects in editor to their original urls.
   * @param {{element: Element, url: string}[]} - An array of embedded objects.
   */
  _restoreEditorContent(embeddedObjects) {
    for (let { element, url } of embeddedObjects) {
      if (element.tagName == "BODY") {
        element.background = url;
      } else if (element.tagName == "IMG") {
        element.src = url;
      } else if (element.tagName == "A") {
        element.href = url;
      }
    }
  },

  /**
   * Get the message body from an editor. This returns a BinaryString because:
   * 1. The body argument of createAndSendMessage is BinaryString.
   * 2. An attachment content is BinaryString.
   * 3. Body text and attachment contents are handled in the same way by
   * MimeEncoder to pick encoding and encode.
   * @param {nsIEditor} editor - The editor instance.
   * @returns {BinaryString}
   */
  _getBodyFromEditor(editor) {
    if (!editor) {
      return "";
    }

    let flags =
      Ci.nsIDocumentEncoder.OutputFormatted |
      Ci.nsIDocumentEncoder.OutputNoFormattingInPre |
      Ci.nsIDocumentEncoder.OutputDisallowLineBreaking;
    // bodyText is UTF-16 string.
    let bodyText = editor.outputToString("text/html", flags);

    // No need to do conversion if forcing plain text.
    if (!this._compFields.forcePlainText) {
      let cs = Cc["@mozilla.org/txttohtmlconv;1"].getService(
        Ci.mozITXTToHTMLConv
      );
      let csFlags = Ci.mozITXTToHTMLConv.kURLs;
      if (Services.prefs.getBoolPref("mail.send_struct", false)) {
        csFlags |= Ci.mozITXTToHTMLConv.kStructPhrase;
      }
      bodyText = cs.scanHTML(bodyText, csFlags);
    }

    // Convert UTF-16 string to byte string.
    return jsmime.mimeutils.typedArrayToString(
      new TextEncoder().encode(bodyText)
    );
  },
};

/**
 * A listener to be passed to the SMTP service.
 *
 * @implements {nsIUrlListener}
 */
function MsgDeliveryListener(msgSend, isNewsDelivery) {
  this._msgSend = msgSend;
  this._isNewsDelivery = isNewsDelivery;
}

MsgDeliveryListener.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),

  OnStartRunningUrl(url) {
    this._msgSend.notifyListenerOnStartSending(null, 0);
  },

  OnStopRunningUrl(url, exitCode) {
    MsgUtils.sendLogger.debug(`OnStopRunningUrl; exitCode=${exitCode}`);
    let mailUrl = url.QueryInterface(Ci.nsIMsgMailNewsUrl);
    mailUrl.UnRegisterListener(this);

    this._msgSend.sendDeliveryCallback(url, this._isNewsDelivery, exitCode);
  },
};
