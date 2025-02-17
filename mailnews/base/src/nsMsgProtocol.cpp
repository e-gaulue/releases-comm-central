/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "msgCore.h"
#include "nsString.h"
#include "nsMemory.h"
#include "nsMsgProtocol.h"
#include "nsIMsgMailNewsUrl.h"
#include "nsIMsgMailSession.h"
#include "nsMsgBaseCID.h"
#include "nsIStreamTransportService.h"
#include "nsISocketTransportService.h"
#include "nsISocketTransport.h"
#include "nsILoadGroup.h"
#include "nsILoadInfo.h"
#include "nsIIOService.h"
#include "nsNetUtil.h"
#include "nsIFileURL.h"
#include "nsIMsgWindow.h"
#include "nsIMsgStatusFeedback.h"
#include "nsIWebProgressListener.h"
#include "nsIPipe.h"
#include "nsIPrompt.h"
#include "prprf.h"
#include "plbase64.h"
#include "nsIStringBundle.h"
#include "nsIProxyInfo.h"
#include "nsThreadUtils.h"
#include "nsIPrefBranch.h"
#include "nsIPrefService.h"
#include "nsDirectoryServiceDefs.h"
#include "nsMsgUtils.h"
#include "nsILineInputStream.h"
#include "nsIAsyncInputStream.h"
#include "nsIMsgIncomingServer.h"
#include "nsIInputStreamPump.h"
#include "nsICancelable.h"
#include "nsMimeTypes.h"
#include "mozilla/Services.h"
#include "mozilla/SlicedInputStream.h"
#include "nsContentSecurityManager.h"
#include "nsPrintfCString.h"

#undef PostMessage  // avoid to collision with WinUser.h

using namespace mozilla;

NS_IMPL_ISUPPORTS_INHERITED(nsMsgProtocol, nsHashPropertyBag, nsIChannel,
                            nsIStreamListener, nsIRequestObserver, nsIRequest,
                            nsITransportEventSink)

static char16_t* FormatStringWithHostNameByName(const char16_t* stringName,
                                                nsIMsgMailNewsUrl* msgUri);

nsMsgProtocol::nsMsgProtocol(nsIURI* aURL) {
  m_flags = 0;
  m_readCount = 0;
  mLoadFlags = 0;
  m_socketIsOpen = false;
  mContentLength = -1;
  m_isChannel = false;
  mContentDisposition = nsIChannel::DISPOSITION_INLINE;

  GetSpecialDirectoryWithFileName(NS_OS_TEMP_DIR, "tempMessage.eml",
                                  getter_AddRefs(m_tempMsgFile));

  mSuppressListenerNotifications = false;
  InitFromURI(aURL);
}

nsresult nsMsgProtocol::InitFromURI(nsIURI* aUrl) {
  m_url = aUrl;

  nsCOMPtr<nsIMsgMailNewsUrl> mailUrl = do_QueryInterface(aUrl);
  if (mailUrl) {
    mailUrl->GetLoadGroup(getter_AddRefs(m_loadGroup));
    nsCOMPtr<nsIMsgStatusFeedback> statusFeedback;
    mailUrl->GetStatusFeedback(getter_AddRefs(statusFeedback));
    mProgressEventSink = do_QueryInterface(statusFeedback);
  }

  // Reset channel data in case the object is reused and initialised again.
  mCharset.Truncate();

  return NS_OK;
}

nsMsgProtocol::~nsMsgProtocol() {}

static bool gGotTimeoutPref;
static int32_t gSocketTimeout = 60;

nsresult nsMsgProtocol::GetQoSBits(uint8_t* aQoSBits) {
  NS_ENSURE_ARG_POINTER(aQoSBits);
  const char* protocol = GetType();

  if (!protocol) return NS_ERROR_NOT_IMPLEMENTED;

  nsAutoCString prefName("mail.");
  prefName.Append(protocol);
  prefName.AppendLiteral(".qos");

  nsresult rv;
  nsCOMPtr<nsIPrefBranch> prefBranch =
      do_GetService(NS_PREFSERVICE_CONTRACTID, &rv);
  NS_ENSURE_SUCCESS(rv, rv);

  int32_t val;
  rv = prefBranch->GetIntPref(prefName.get(), &val);
  NS_ENSURE_SUCCESS(rv, rv);
  *aQoSBits = (uint8_t)clamped(val, 0, 0xff);
  return NS_OK;
}

nsresult nsMsgProtocol::OpenNetworkSocketWithInfo(
    const char* aHostName, int32_t aGetPort, const char* connectionType,
    nsIProxyInfo* aProxyInfo, nsIInterfaceRequestor* callbacks) {
  NS_ENSURE_ARG(aHostName);

  nsresult rv = NS_OK;
  nsCOMPtr<nsISocketTransportService> socketService(
      do_GetService(NS_SOCKETTRANSPORTSERVICE_CONTRACTID));
  NS_ENSURE_TRUE(socketService, NS_ERROR_FAILURE);

  // with socket connections we want to read as much data as arrives
  m_readCount = -1;

  nsCOMPtr<nsISocketTransport> strans;
  AutoTArray<nsCString, 1> connectionTypeArray;
  if (connectionType) connectionTypeArray.AppendElement(connectionType);
  rv = socketService->CreateTransport(
      connectionTypeArray, nsDependentCString(aHostName), aGetPort, aProxyInfo,
      nullptr, getter_AddRefs(strans));
  if (NS_FAILED(rv)) return rv;

  strans->SetSecurityCallbacks(callbacks);

  // creates cyclic reference!
  nsCOMPtr<nsIThread> currentThread(do_GetCurrentThread());
  strans->SetEventSink(this, currentThread);

  m_socketIsOpen = false;
  m_transport = strans;

  if (!gGotTimeoutPref) {
    nsCOMPtr<nsIPrefBranch> prefBranch =
        do_GetService(NS_PREFSERVICE_CONTRACTID, &rv);
    if (prefBranch) {
      prefBranch->GetIntPref("mailnews.tcptimeout", &gSocketTimeout);
      gGotTimeoutPref = true;
    }
  }
  strans->SetTimeout(nsISocketTransport::TIMEOUT_CONNECT, gSocketTimeout + 60);
  strans->SetTimeout(nsISocketTransport::TIMEOUT_READ_WRITE, gSocketTimeout);

  uint8_t qos;
  rv = GetQoSBits(&qos);
  if (NS_SUCCEEDED(rv)) strans->SetQoSBits(qos);

  return SetupTransportState();
}

nsresult nsMsgProtocol::GetFileFromURL(nsIURI* aURL, nsIFile** aResult) {
  NS_ENSURE_ARG_POINTER(aURL);
  NS_ENSURE_ARG_POINTER(aResult);
  // extract the file path from the uri...
  nsAutoCString urlSpec;
  aURL->GetPathQueryRef(urlSpec);
  urlSpec.InsertLiteral("file://", 0);
  nsresult rv;

  // dougt - there should be an easier way!
  nsCOMPtr<nsIURI> uri;
  if (NS_FAILED(rv = NS_NewURI(getter_AddRefs(uri), urlSpec.get()))) return rv;

  nsCOMPtr<nsIFileURL> fileURL = do_QueryInterface(uri);
  if (!fileURL) return NS_ERROR_FAILURE;

  return fileURL->GetFile(aResult);
  // dougt
}

nsresult nsMsgProtocol::OpenFileSocket(nsIURI* aURL, uint64_t aStartPosition,
                                       int64_t aReadCount) {
  // mscott - file needs to be encoded directly into aURL. I should be able to
  // get rid of this method completely.

  nsresult rv = NS_OK;
  m_readCount = aReadCount;
  nsCOMPtr<nsIFile> file;

  rv = GetFileFromURL(aURL, getter_AddRefs(file));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIInputStream> stream;
  rv = NS_NewLocalFileInputStream(getter_AddRefs(stream), file);
  if (NS_FAILED(rv)) return rv;

  // create input stream transport
  nsCOMPtr<nsIStreamTransportService> sts =
      do_GetService(NS_STREAMTRANSPORTSERVICE_CONTRACTID, &rv);
  if (NS_FAILED(rv)) return rv;

  // This can be called with aReadCount == -1 which means "read as much as we
  // can". We pass this on as UINT64_MAX, which is in fact uint64_t(-1).
  RefPtr<SlicedInputStream> slicedStream = new SlicedInputStream(
      stream.forget(), aStartPosition,
      aReadCount == -1 ? UINT64_MAX : uint64_t(aReadCount));
  rv = sts->CreateInputTransport(slicedStream, true,
                                 getter_AddRefs(m_transport));

  m_socketIsOpen = false;
  return rv;
}

nsresult nsMsgProtocol::GetTopmostMsgWindow(nsIMsgWindow** aWindow) {
  nsresult rv;
  nsCOMPtr<nsIMsgMailSession> mailSession(
      do_GetService(NS_MSGMAILSESSION_CONTRACTID, &rv));
  NS_ENSURE_SUCCESS(rv, rv);
  return mailSession->GetTopmostMsgWindow(aWindow);
}

nsresult nsMsgProtocol::SetupTransportState() {
  if (!m_socketIsOpen && m_transport) {
    nsresult rv;

    // open buffered, blocking output stream
    rv = m_transport->OpenOutputStream(nsITransport::OPEN_BLOCKING, 0, 0,
                                       getter_AddRefs(m_outputStream));
    if (NS_FAILED(rv)) return rv;
    // we want to open the stream
  }  // if m_transport

  return NS_OK;
}

nsresult nsMsgProtocol::CloseSocket() {
  nsresult rv = NS_OK;
  // release all of our socket state
  m_socketIsOpen = false;
  m_outputStream = nullptr;
  if (m_transport) {
    nsCOMPtr<nsISocketTransport> strans = do_QueryInterface(m_transport);
    if (strans) {
      strans->SetEventSink(nullptr, nullptr);  // break cyclic reference!
    }
  }
  // we need to call Cancel so that we remove the socket transport from the
  // mActiveTransportList.  see bug #30648
  if (m_request) {
    rv = m_request->Cancel(NS_BINDING_ABORTED);
  }
  m_request = nullptr;
  if (m_transport) {
    m_transport->Close(NS_BINDING_ABORTED);
    m_transport = nullptr;
  }

  return rv;
}

/*
 * Writes the data contained in dataBuffer into the current output stream. It
 * also informs the transport layer that this data is now available for
 * transmission. Returns a positive number for success, 0 for failure (not all
 * the bytes were written to the stream, etc). We need to make another pass
 * through this file to install an error system (mscott)
 *
 * No logging is done in the base implementation, so aSuppressLogging is
 * ignored.
 */

nsresult nsMsgProtocol::SendData(const char* dataBuffer,
                                 bool aSuppressLogging) {
  uint32_t writeCount = 0;

  if (dataBuffer && m_outputStream)
    return m_outputStream->Write(dataBuffer, PL_strlen(dataBuffer),
                                 &writeCount);
  // TODO make sure all the bytes in PL_strlen(dataBuffer) were written
  else
    return NS_ERROR_INVALID_ARG;
}

// Whenever data arrives from the connection, core netlib notifices the protocol
// by calling OnDataAvailable. We then read and process the incoming data from
// the input stream.
NS_IMETHODIMP nsMsgProtocol::OnDataAvailable(nsIRequest* request,
                                             nsIInputStream* inStr,
                                             uint64_t sourceOffset,
                                             uint32_t count) {
  // right now, this really just means turn around and churn through the state
  // machine
  nsCOMPtr<nsIURI> uri;
  GetURI(getter_AddRefs(uri));

  return ProcessProtocolState(uri, inStr, sourceOffset, count);
}

NS_IMETHODIMP nsMsgProtocol::OnStartRequest(nsIRequest* request) {
  nsresult rv = NS_OK;
  nsCOMPtr<nsIURI> uri;
  GetURI(getter_AddRefs(uri));

  if (uri) {
    nsCOMPtr<nsIMsgMailNewsUrl> aMsgUrl = do_QueryInterface(uri);
    rv = aMsgUrl->SetUrlState(true, NS_OK);
    if (m_loadGroup)
      m_loadGroup->AddRequest(static_cast<nsIRequest*>(this),
                              nullptr /* context isupports */);
  }

  // if we are set up as a channel, we should notify our channel listener that
  // we are starting... so pass in ourself as the channel and not the underlying
  // socket or file channel the protocol happens to be using
  if (!mSuppressListenerNotifications && m_channelListener) {
    m_isChannel = true;
    rv = m_channelListener->OnStartRequest(this);
  }

  nsCOMPtr<nsISocketTransport> strans = do_QueryInterface(m_transport);

  if (strans)
    strans->SetTimeout(nsISocketTransport::TIMEOUT_READ_WRITE, gSocketTimeout);

  NS_ENSURE_SUCCESS(rv, rv);
  return rv;
}

void nsMsgProtocol::ShowAlertMessage(nsIMsgMailNewsUrl* aMsgUrl,
                                     nsresult aStatus) {
  const char16_t* errorString = nullptr;
  switch (aStatus) {
    case NS_ERROR_UNKNOWN_HOST:
    case NS_ERROR_UNKNOWN_PROXY_HOST:
      errorString = u"unknownHostError";
      break;
    case NS_ERROR_CONNECTION_REFUSED:
    case NS_ERROR_PROXY_CONNECTION_REFUSED:
      errorString = u"connectionRefusedError";
      break;
    case NS_ERROR_NET_TIMEOUT:
      errorString = u"netTimeoutError";
      break;
    case NS_ERROR_NET_RESET:
      errorString = u"netResetError";
      break;
    case NS_ERROR_NET_INTERRUPT:
      errorString = u"netInterruptError";
      break;
    case NS_ERROR_OFFLINE:
      // Don't alert when offline as that is already displayed in the UI.
      return;
    default:
      nsPrintfCString msg(
          "Unexpected status passed to ShowAlertMessage: %" PRIx32,
          static_cast<uint32_t>(aStatus));
      NS_WARNING(msg.get());
      return;
  }

  nsString errorMsg;
  errorMsg.Adopt(FormatStringWithHostNameByName(errorString, aMsgUrl));
  if (errorMsg.IsEmpty()) {
    errorMsg.AssignLiteral(u"[StringID ");
    errorMsg.Append(errorString);
    errorMsg.AppendLiteral(u"?]");
  }

  nsCOMPtr<nsIMsgMailSession> mailSession =
      do_GetService(NS_MSGMAILSESSION_CONTRACTID);
  if (mailSession) mailSession->AlertUser(errorMsg, aMsgUrl);
}

// stop binding is a "notification" informing us that the stream associated with
// aURL is going away.
NS_IMETHODIMP nsMsgProtocol::OnStopRequest(nsIRequest* request,
                                           nsresult aStatus) {
  nsresult rv = NS_OK;

  // if we are set up as a channel, we should notify our channel listener that
  // we are starting... so pass in ourself as the channel and not the underlying
  // socket or file channel the protocol happens to be using
  if (!mSuppressListenerNotifications && m_channelListener)
    rv = m_channelListener->OnStopRequest(this, aStatus);

  nsCOMPtr<nsIURI> uri;
  GetURI(getter_AddRefs(uri));

  if (uri) {
    nsCOMPtr<nsIMsgMailNewsUrl> msgUrl = do_QueryInterface(uri);
    rv = msgUrl->SetUrlState(false, aStatus);  // Always returns NS_OK.
    if (m_loadGroup)
      m_loadGroup->RemoveRequest(static_cast<nsIRequest*>(this), nullptr,
                                 aStatus);

    // !m_isChannel because if we're set up as a channel, then the remove
    // request above will handle alerting the user, so we don't need to.
    //
    // !NS_BINDING_ABORTED because we don't want to see an alert if the user
    // cancelled the operation.  also, we'll get here because we call Cancel()
    // to force removal of the nsSocketTransport.  see CloseSocket()
    // bugs #30775 and #30648 relate to this
    if (!m_isChannel && NS_FAILED(aStatus) && (aStatus != NS_BINDING_ABORTED))
      ShowAlertMessage(msgUrl, aStatus);
  }  // if we have a mailnews url.

  // Drop notification callbacks to prevent cycles.
  mCallbacks = nullptr;
  mProgressEventSink = nullptr;
  // Call CloseSocket(), in case we got here because the server dropped the
  // connection while reading, and we never get a chance to get back into
  // the protocol state machine via OnDataAvailable.
  if (m_socketIsOpen) CloseSocket();

  return rv;
}

nsresult nsMsgProtocol::GetPromptDialogFromUrl(nsIMsgMailNewsUrl* aMsgUrl,
                                               nsIPrompt** aPromptDialog) {
  // get the nsIPrompt interface from the message window associated wit this
  // url.
  nsCOMPtr<nsIMsgWindow> msgWindow;
  aMsgUrl->GetMsgWindow(getter_AddRefs(msgWindow));
  NS_ENSURE_TRUE(msgWindow, NS_ERROR_FAILURE);

  msgWindow->GetPromptDialog(aPromptDialog);

  NS_ENSURE_TRUE(*aPromptDialog, NS_ERROR_FAILURE);

  return NS_OK;
}

nsresult nsMsgProtocol::LoadUrl(nsIURI* aURL, nsISupports* aConsumer) {
  // nsMsgProtocol implements nsIChannel, and all channels are required to
  // have non-null loadInfo. So if it's still unset, we've not been correctly
  // initialised.
  MOZ_ASSERT(m_loadInfo);

  // okay now kick us off to the next state...
  // our first state is a process state so drive the state machine...
  nsresult rv = NS_OK;
  nsCOMPtr<nsIMsgMailNewsUrl> aMsgUrl = do_QueryInterface(aURL, &rv);

  if (NS_SUCCEEDED(rv) && aMsgUrl) {
    bool msgIsInLocalCache;
    aMsgUrl->GetMsgIsInLocalCache(&msgIsInLocalCache);

    // Set the url as a url currently being run...
    rv = aMsgUrl->SetUrlState(true, NS_OK);

    // if the url is given a stream consumer then we should use it to forward
    // calls to...
    if (!m_channelListener &&
        aConsumer)  // if we don't have a registered listener already
    {
      m_channelListener = do_QueryInterface(aConsumer);
      m_isChannel = true;
    }

    if (!m_socketIsOpen) {
      if (m_transport) {
        // open buffered, asynchronous input stream
        nsCOMPtr<nsIInputStream> stream;
        rv = m_transport->OpenInputStream(0, 0, 0, getter_AddRefs(stream));
        if (NS_FAILED(rv)) return rv;

        // m_readCount can be -1 which means "read as much as we can".
        // We pass this on as UINT64_MAX, which is in fact uint64_t(-1).
        // We don't clone m_inputStream here, we simply give up ownership
        // since otherwise the original would never be closed.
        RefPtr<SlicedInputStream> slicedStream = new SlicedInputStream(
            stream.forget(), 0,
            m_readCount == -1 ? UINT64_MAX : uint64_t(m_readCount));
        nsCOMPtr<nsIInputStreamPump> pump;
        rv = NS_NewInputStreamPump(getter_AddRefs(pump), slicedStream.forget());
        if (NS_FAILED(rv)) return rv;

        m_request = pump;  // keep a reference to the pump so we can cancel it

        // Put us in a state where we are always notified of incoming data.
        // OnDataAvailable() will be called when that happens, which will
        // pass that data into ProcessProtocolState().
        rv = pump->AsyncRead(this);
        NS_ASSERTION(NS_SUCCEEDED(rv), "AsyncRead failed");
        m_socketIsOpen = true;  // mark the channel as open
      }
    } else if (!msgIsInLocalCache) {
      // The connection is already open so we should begin processing our url.
      rv = ProcessProtocolState(aURL, nullptr, 0, 0);
    }
  }

  return rv;
}

///////////////////////////////////////////////////////////////////////
// The rest of this file is mostly nsIChannel mumbo jumbo stuff
///////////////////////////////////////////////////////////////////////

nsresult nsMsgProtocol::SetUrl(nsIURI* aURL) {
  m_url = aURL;
  return NS_OK;
}

NS_IMETHODIMP nsMsgProtocol::SetLoadGroup(nsILoadGroup* aLoadGroup) {
  m_loadGroup = aLoadGroup;
  return NS_OK;
}

NS_IMETHODIMP nsMsgProtocol::GetTRRMode(nsIRequest::TRRMode* aTRRMode) {
  return GetTRRModeImpl(aTRRMode);
}

NS_IMETHODIMP nsMsgProtocol::SetTRRMode(nsIRequest::TRRMode aTRRMode) {
  return SetTRRModeImpl(aTRRMode);
}

NS_IMETHODIMP nsMsgProtocol::GetOriginalURI(nsIURI** aURI) {
  NS_IF_ADDREF(*aURI = m_originalUrl ? m_originalUrl : m_url);
  return NS_OK;
}

NS_IMETHODIMP nsMsgProtocol::SetOriginalURI(nsIURI* aURI) {
  m_originalUrl = aURI;
  return NS_OK;
}

NS_IMETHODIMP nsMsgProtocol::GetURI(nsIURI** aURI) {
  NS_IF_ADDREF(*aURI = m_url);
  return NS_OK;
}

NS_IMETHODIMP nsMsgProtocol::Open(nsIInputStream** _retval) {
  nsCOMPtr<nsIStreamListener> listener;
  nsresult rv =
      nsContentSecurityManager::doContentSecurityCheck(this, listener);
  NS_ENSURE_SUCCESS(rv, rv);
  return NS_ImplementChannelOpen(this, _retval);
}

NS_IMETHODIMP nsMsgProtocol::AsyncOpen(nsIStreamListener* aListener) {
  nsCOMPtr<nsIStreamListener> listener = aListener;
  nsresult rv =
      nsContentSecurityManager::doContentSecurityCheck(this, listener);
  NS_ENSURE_SUCCESS(rv, rv);

  int32_t port;
  rv = m_url->GetPort(&port);
  if (NS_FAILED(rv)) return rv;

  nsAutoCString scheme;
  rv = m_url->GetScheme(scheme);
  if (NS_FAILED(rv)) return rv;

  rv = NS_CheckPortSafety(port, scheme.get());
  if (NS_FAILED(rv)) return rv;

  // set the stream listener and then load the url
  m_isChannel = true;

  m_channelListener = listener;
  return LoadUrl(m_url, nullptr);
}

NS_IMETHODIMP nsMsgProtocol::GetLoadFlags(nsLoadFlags* aLoadFlags) {
  *aLoadFlags = mLoadFlags;
  return NS_OK;
}

NS_IMETHODIMP nsMsgProtocol::SetLoadFlags(nsLoadFlags aLoadFlags) {
  mLoadFlags = aLoadFlags;
  return NS_OK;  // don't fail when trying to set this
}

NS_IMETHODIMP nsMsgProtocol::GetContentType(nsACString& aContentType) {
  // as url dispatching matures, we'll be intelligent and actually start
  // opening the url before specifying the content type. This will allow
  // us to optimize the case where the message url actual refers to
  // a part in the message that has a content type that is not message/rfc822

  if (mContentType.IsEmpty())
    aContentType.AssignLiteral("message/rfc822");
  else
    aContentType = mContentType;
  return NS_OK;
}

NS_IMETHODIMP nsMsgProtocol::SetContentType(const nsACString& aContentType) {
  nsAutoCString charset;
  nsresult rv =
      NS_ParseResponseContentType(aContentType, mContentType, charset);
  if (NS_FAILED(rv) || mContentType.IsEmpty())
    mContentType.AssignLiteral(UNKNOWN_CONTENT_TYPE);
  return rv;
}

NS_IMETHODIMP nsMsgProtocol::GetContentCharset(nsACString& aContentCharset) {
  aContentCharset.Assign(mCharset);
  return NS_OK;
}

NS_IMETHODIMP nsMsgProtocol::SetContentCharset(
    const nsACString& aContentCharset) {
  mCharset.Assign(aContentCharset);
  return NS_OK;
}

NS_IMETHODIMP
nsMsgProtocol::GetContentDisposition(uint32_t* aContentDisposition) {
  *aContentDisposition = mContentDisposition;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgProtocol::SetContentDisposition(uint32_t aContentDisposition) {
  mContentDisposition = aContentDisposition;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgProtocol::GetContentDispositionFilename(
    nsAString& aContentDispositionFilename) {
  return NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP
nsMsgProtocol::SetContentDispositionFilename(
    const nsAString& aContentDispositionFilename) {
  return NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP
nsMsgProtocol::GetContentDispositionHeader(
    nsACString& aContentDispositionHeader) {
  return NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP nsMsgProtocol::GetContentLength(int64_t* aContentLength) {
  *aContentLength = mContentLength;
  return NS_OK;
}

NS_IMETHODIMP nsMsgProtocol::SetContentLength(int64_t aContentLength) {
  mContentLength = aContentLength;
  return NS_OK;
}

NS_IMETHODIMP nsMsgProtocol::GetSecurityInfo(nsISupports** secInfo) {
  if (m_transport) {
    nsCOMPtr<nsISocketTransport> strans = do_QueryInterface(m_transport);
    if (strans) {
      return strans->GetSecurityInfo(secInfo);
    }
  }
  *secInfo = nullptr;
  return NS_OK;
}

NS_IMETHODIMP nsMsgProtocol::GetName(nsACString& result) {
  if (m_url) return m_url->GetSpec(result);
  result.Truncate();
  return NS_OK;
}

NS_IMETHODIMP nsMsgProtocol::GetOwner(nsISupports** aPrincipal) {
  NS_IF_ADDREF(*aPrincipal = mOwner);
  return NS_OK;
}

NS_IMETHODIMP nsMsgProtocol::SetOwner(nsISupports* aPrincipal) {
  mOwner = aPrincipal;
  return NS_OK;
}

NS_IMETHODIMP nsMsgProtocol::GetLoadGroup(nsILoadGroup** aLoadGroup) {
  NS_IF_ADDREF(*aLoadGroup = m_loadGroup);
  return NS_OK;
}

NS_IMETHODIMP nsMsgProtocol::GetLoadInfo(nsILoadInfo** aLoadInfo) {
  NS_IF_ADDREF(*aLoadInfo = m_loadInfo);
  return NS_OK;
}

NS_IMETHODIMP nsMsgProtocol::SetLoadInfo(nsILoadInfo* aLoadInfo) {
  m_loadInfo = aLoadInfo;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgProtocol::GetNotificationCallbacks(
    nsIInterfaceRequestor** aNotificationCallbacks) {
  NS_IF_ADDREF(*aNotificationCallbacks = mCallbacks.get());
  return NS_OK;
}

NS_IMETHODIMP
nsMsgProtocol::SetNotificationCallbacks(
    nsIInterfaceRequestor* aNotificationCallbacks) {
  mCallbacks = aNotificationCallbacks;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgProtocol::OnTransportStatus(nsITransport* transport, nsresult status,
                                 int64_t progress, int64_t progressMax) {
  if ((mLoadFlags & LOAD_BACKGROUND) || !m_url) return NS_OK;

  // these transport events should not generate any status messages
  if (status == NS_NET_STATUS_RECEIVING_FROM ||
      status == NS_NET_STATUS_SENDING_TO)
    return NS_OK;

  if (!mProgressEventSink) {
    NS_QueryNotificationCallbacks(mCallbacks, m_loadGroup, mProgressEventSink);
    if (!mProgressEventSink) return NS_OK;
  }

  nsAutoCString host;
  m_url->GetHost(host);

  nsCOMPtr<nsIMsgMailNewsUrl> mailnewsUrl = do_QueryInterface(m_url);
  if (mailnewsUrl) {
    nsCOMPtr<nsIMsgIncomingServer> server;
    mailnewsUrl->GetServer(getter_AddRefs(server));
    if (server) server->GetRealHostName(host);
  }
  mProgressEventSink->OnStatus(this, status, NS_ConvertUTF8toUTF16(host).get());

  return NS_OK;
}

NS_IMETHODIMP
nsMsgProtocol::GetIsDocument(bool* aIsDocument) {
  return NS_GetIsDocumentChannel(this, aIsDocument);
}

////////////////////////////////////////////////////////////////////////////////
// From nsIRequest
////////////////////////////////////////////////////////////////////////////////

NS_IMETHODIMP nsMsgProtocol::IsPending(bool* result) {
  *result = m_channelListener != nullptr;
  return NS_OK;
}

NS_IMETHODIMP nsMsgProtocol::GetStatus(nsresult* status) {
  if (m_request) return m_request->GetStatus(status);

  *status = NS_OK;
  return *status;
}

NS_IMETHODIMP nsMsgProtocol::Cancel(nsresult status) {
  if (m_proxyRequest) m_proxyRequest->Cancel(status);

  if (m_request) return m_request->Cancel(status);

  NS_WARNING("no request to cancel");
  return NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP nsMsgProtocol::GetCanceled(bool* aCanceled) {
  nsresult status = NS_ERROR_FAILURE;
  GetStatus(&status);
  *aCanceled = NS_FAILED(status);
  return NS_OK;
}

NS_IMETHODIMP nsMsgProtocol::Suspend() {
  if (m_request) return m_request->Suspend();

  NS_WARNING("no request to suspend");
  return NS_ERROR_NOT_AVAILABLE;
}

NS_IMETHODIMP nsMsgProtocol::Resume() {
  if (m_request) return m_request->Resume();

  NS_WARNING("no request to resume");
  return NS_ERROR_NOT_AVAILABLE;
}

nsresult nsMsgProtocol::PostMessage(nsIURI* url, nsIFile* postFile) {
  if (!url || !postFile) return NS_ERROR_NULL_POINTER;

#define POST_DATA_BUFFER_SIZE 2048

  // mscott -- this function should be re-written to use the file url code
  // so it can be asynch
  nsCOMPtr<nsIInputStream> inputStream;
  nsresult rv =
      NS_NewLocalFileInputStream(getter_AddRefs(inputStream), postFile);
  NS_ENSURE_SUCCESS(rv, rv);
  nsCOMPtr<nsILineInputStream> lineInputStream(
      do_QueryInterface(inputStream, &rv));
  NS_ENSURE_SUCCESS(rv, rv);

  bool more = true;
  nsCString line;
  nsCString outputBuffer;

  do {
    lineInputStream->ReadLine(line, &more);

    /* escape starting periods
     */
    if (line.CharAt(0) == '.') line.Insert('.', 0);
    line.AppendLiteral(CRLF);
    outputBuffer.Append(line);
    // test hack by mscott. If our buffer is almost full, then
    // send it off & reset ourselves
    // to make more room.
    if (outputBuffer.Length() > POST_DATA_BUFFER_SIZE || !more) {
      rv = SendData(outputBuffer.get());
      NS_ENSURE_SUCCESS(rv, rv);
      // does this keep the buffer around? That would be best.
      // Maybe SetLength(0) instead?
      outputBuffer.Truncate();
    }
  } while (more);

  return NS_OK;
}

nsresult nsMsgProtocol::DoGSSAPIStep1(const nsACString& service,
                                      const char* username,
                                      nsCString& response) {
  nsresult rv;
#ifdef DEBUG_BenB
  printf("GSSAPI step 1 for service %s, username %s\n", service, username);
#endif

  // if this fails, then it means that we cannot do GSSAPI SASL.
  m_authModule = nsIAuthModule::CreateInstance("sasl-gssapi");

  m_authModule->Init(service, nsIAuthModule::REQ_DEFAULT, u""_ns,
                     NS_ConvertUTF8toUTF16(username), u""_ns);

  void* outBuf;
  uint32_t outBufLen;
  rv = m_authModule->GetNextToken((void*)nullptr, 0, &outBuf, &outBufLen);
  if (NS_SUCCEEDED(rv) && outBuf) {
    char* base64Str = PL_Base64Encode((char*)outBuf, outBufLen, nullptr);
    if (base64Str)
      response.Adopt(base64Str);
    else
      rv = NS_ERROR_OUT_OF_MEMORY;
    free(outBuf);
  }

#ifdef DEBUG_BenB
  printf("GSSAPI step 1 succeeded\n");
#endif
  return rv;
}

nsresult nsMsgProtocol::DoGSSAPIStep2(nsCString& commandResponse,
                                      nsCString& response) {
#ifdef DEBUG_BenB
  printf("GSSAPI step 2\n");
#endif
  nsresult rv;
  void *inBuf, *outBuf;
  uint32_t inBufLen, outBufLen;
  uint32_t len = commandResponse.Length();

  // Cyrus SASL may send us zero length tokens (grrrr)
  if (len > 0) {
    // decode into the input secbuffer
    inBufLen = (len * 3) / 4;  // sufficient size (see plbase64.h)
    inBuf = moz_xmalloc(inBufLen);
    if (!inBuf) return NS_ERROR_OUT_OF_MEMORY;

    // strip off any padding (see bug 230351)
    const char* challenge = commandResponse.get();
    while (challenge[len - 1] == '=') len--;

    // We need to know the exact length of the decoded string to give to
    // the GSSAPI libraries. But NSPR's base64 routine doesn't seem capable
    // of telling us that. So, we figure it out for ourselves.

    // For every 4 characters, add 3 to the destination
    // If there are 3 remaining, add 2
    // If there are 2 remaining, add 1
    // 1 remaining is an error
    inBufLen =
        (len / 4) * 3 + ((len % 4 == 3) ? 2 : 0) + ((len % 4 == 2) ? 1 : 0);

    rv = (PL_Base64Decode(challenge, len, (char*)inBuf))
             ? m_authModule->GetNextToken(inBuf, inBufLen, &outBuf, &outBufLen)
             : NS_ERROR_FAILURE;

    free(inBuf);
  } else {
    rv = m_authModule->GetNextToken(NULL, 0, &outBuf, &outBufLen);
  }
  if (NS_SUCCEEDED(rv)) {
    // And in return, we may need to send Cyrus zero length tokens back
    if (outBuf) {
      char* base64Str = PL_Base64Encode((char*)outBuf, outBufLen, nullptr);
      if (base64Str)
        response.Adopt(base64Str);
      else
        rv = NS_ERROR_OUT_OF_MEMORY;
    } else
      response.Adopt((char*)moz_xmemdup("", 1));
  }

#ifdef DEBUG_BenB
  printf(NS_SUCCEEDED(rv) ? "GSSAPI step 2 succeeded\n"
                          : "GSSAPI step 2 failed\n");
#endif
  return rv;
}

nsresult nsMsgProtocol::DoNtlmStep1(const nsACString& username,
                                    const nsAString& password,
                                    nsCString& response) {
  nsresult rv;

  m_authModule = nsIAuthModule::CreateInstance("ntlm");

  m_authModule->Init(""_ns, 0, u""_ns, NS_ConvertUTF8toUTF16(username),
                     PromiseFlatString(password));

  void* outBuf;
  uint32_t outBufLen;
  rv = m_authModule->GetNextToken((void*)nullptr, 0, &outBuf, &outBufLen);
  if (NS_SUCCEEDED(rv) && outBuf) {
    char* base64Str = PL_Base64Encode((char*)outBuf, outBufLen, nullptr);
    if (base64Str)
      response.Adopt(base64Str);
    else
      rv = NS_ERROR_OUT_OF_MEMORY;
    free(outBuf);
  }

  return rv;
}

nsresult nsMsgProtocol::DoNtlmStep2(nsCString& commandResponse,
                                    nsCString& response) {
  nsresult rv;
  void *inBuf, *outBuf;
  uint32_t inBufLen, outBufLen;
  uint32_t len = commandResponse.Length();

  // decode into the input secbuffer
  inBufLen = (len * 3) / 4;  // sufficient size (see plbase64.h)
  inBuf = moz_xmalloc(inBufLen);
  if (!inBuf) return NS_ERROR_OUT_OF_MEMORY;

  // strip off any padding (see bug 230351)
  const char* challenge = commandResponse.get();
  while (challenge[len - 1] == '=') len--;

  rv = (PL_Base64Decode(challenge, len, (char*)inBuf))
           ? m_authModule->GetNextToken(inBuf, inBufLen, &outBuf, &outBufLen)
           : NS_ERROR_FAILURE;

  free(inBuf);
  if (NS_SUCCEEDED(rv) && outBuf) {
    char* base64Str = PL_Base64Encode((char*)outBuf, outBufLen, nullptr);
    if (base64Str)
      response.Adopt(base64Str);
    else
      rv = NS_ERROR_OUT_OF_MEMORY;
  }

  if (NS_FAILED(rv)) response = "*";

  return rv;
}

/////////////////////////////////////////////////////////////////////
// nsMsgAsyncWriteProtocol subclass and related helper classes
/////////////////////////////////////////////////////////////////////

class nsMsgProtocolStreamProvider : public nsIOutputStreamCallback {
 public:
  // XXX this probably doesn't need to be threadsafe
  NS_DECL_THREADSAFE_ISUPPORTS

  nsMsgProtocolStreamProvider() {}

  void Init(nsMsgAsyncWriteProtocol* aProtInstance,
            nsIInputStream* aInputStream) {
    mMsgProtocol =
        do_GetWeakReference(static_cast<nsIStreamListener*>(aProtInstance));
    mInStream = aInputStream;
  }

  //
  // nsIOutputStreamCallback implementation ...
  //
  NS_IMETHODIMP OnOutputStreamReady(nsIAsyncOutputStream* aOutStream) override {
    NS_ASSERTION(mInStream, "not initialized");

    nsresult rv;
    uint64_t avail;

    // Write whatever is available in the pipe. If the pipe is empty, then
    // return NS_BASE_STREAM_WOULD_BLOCK; we will resume the write when there
    // is more data.

    rv = mInStream->Available(&avail);
    if (NS_FAILED(rv)) return rv;

    nsMsgAsyncWriteProtocol* protInst = nullptr;
    nsCOMPtr<nsIStreamListener> callback = do_QueryReferent(mMsgProtocol);
    if (!callback) return NS_ERROR_FAILURE;
    protInst = static_cast<nsMsgAsyncWriteProtocol*>(callback.get());

    if (avail == 0 && !protInst->mAsyncBuffer.Length()) {
      // ok, stop writing...
      protInst->mSuspendedWrite = true;
      return NS_OK;
    }
    protInst->mSuspendedWrite = false;

    uint32_t bytesWritten;

    if (avail) {
      rv = aOutStream->WriteFrom(mInStream,
                                 std::min(avail, uint64_t(FILE_IO_BUFFER_SIZE)),
                                 &bytesWritten);
      // if were full at the time, the input stream may be backed up and we need
      // to read any remains from the last ODA call before we'll get more ODA
      // calls
      if (protInst->mSuspendedRead) protInst->UnblockPostReader();
    } else {
      rv = aOutStream->Write(protInst->mAsyncBuffer.get(),
                             protInst->mAsyncBuffer.Length(), &bytesWritten);
      protInst->mAsyncBuffer.Cut(0, bytesWritten);
    }

    protInst->UpdateProgress(bytesWritten);

    // try to write again...
    if (NS_SUCCEEDED(rv))
      rv = aOutStream->AsyncWait(this, 0, 0, protInst->mProviderThread);

    NS_ASSERTION(NS_SUCCEEDED(rv) || rv == NS_BINDING_ABORTED,
                 "unexpected error writing stream");
    return NS_OK;
  }

 protected:
  virtual ~nsMsgProtocolStreamProvider() {}

  nsWeakPtr mMsgProtocol;
  nsCOMPtr<nsIInputStream> mInStream;
};

NS_IMPL_ISUPPORTS(nsMsgProtocolStreamProvider, nsIOutputStreamCallback)

class nsMsgFilePostHelper : public nsIStreamListener {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIREQUESTOBSERVER
  NS_DECL_NSISTREAMLISTENER

  nsMsgFilePostHelper() { mSuspendedPostFileRead = false; }
  nsresult Init(nsIOutputStream* aOutStream,
                nsMsgAsyncWriteProtocol* aProtInstance, nsIFile* aFileToPost);
  nsCOMPtr<nsIRequest> mPostFileRequest;
  bool mSuspendedPostFileRead;
  void CloseSocket() { mProtInstance = nullptr; }

 protected:
  virtual ~nsMsgFilePostHelper() {}
  nsCOMPtr<nsIOutputStream> mOutStream;
  nsWeakPtr mProtInstance;
};

NS_IMPL_ISUPPORTS(nsMsgFilePostHelper, nsIStreamListener, nsIRequestObserver)

nsresult nsMsgFilePostHelper::Init(nsIOutputStream* aOutStream,
                                   nsMsgAsyncWriteProtocol* aProtInstance,
                                   nsIFile* aFileToPost) {
  nsresult rv = NS_OK;
  mOutStream = aOutStream;
  mProtInstance =
      do_GetWeakReference(static_cast<nsIStreamListener*>(aProtInstance));

  nsCOMPtr<nsIInputStream> stream;
  rv = NS_NewLocalFileInputStream(getter_AddRefs(stream), aFileToPost);
  if (NS_FAILED(rv)) return rv;

  nsCOMPtr<nsIInputStreamPump> pump;
  rv = NS_NewInputStreamPump(getter_AddRefs(pump), stream.forget());
  if (NS_FAILED(rv)) return rv;

  rv = pump->AsyncRead(this);
  if (NS_FAILED(rv)) return rv;

  mPostFileRequest = pump;
  return NS_OK;
}

NS_IMETHODIMP nsMsgFilePostHelper::OnStartRequest(nsIRequest* aChannel) {
  return NS_OK;
}

NS_IMETHODIMP nsMsgFilePostHelper::OnStopRequest(nsIRequest* aChannel,
                                                 nsresult aStatus) {
  nsMsgAsyncWriteProtocol* protInst = nullptr;
  nsCOMPtr<nsIStreamListener> callback = do_QueryReferent(mProtInstance);
  if (!callback) return NS_OK;
  protInst = static_cast<nsMsgAsyncWriteProtocol*>(callback.get());

  if (!mSuspendedPostFileRead) protInst->PostDataFinished();

  mSuspendedPostFileRead = false;
  protInst->mFilePostHelper = nullptr;
  return NS_OK;
}

NS_IMETHODIMP nsMsgFilePostHelper::OnDataAvailable(nsIRequest* /* aChannel */,
                                                   nsIInputStream* inStr,
                                                   uint64_t sourceOffset,
                                                   uint32_t count) {
  nsMsgAsyncWriteProtocol* protInst = nullptr;
  nsCOMPtr<nsIStreamListener> callback = do_QueryReferent(mProtInstance);
  if (!callback) return NS_OK;

  protInst = static_cast<nsMsgAsyncWriteProtocol*>(callback.get());

  if (mSuspendedPostFileRead) {
    protInst->UpdateSuspendedReadBytes(count, protInst->mInsertPeriodRequired);
    return NS_OK;
  }

  protInst->ProcessIncomingPostData(inStr, count);

  if (protInst->mSuspendedWrite) {
    // if we got here then we had suspended the write 'cause we didn't have
    // anymore data to write (i.e. the pipe went empty). So resume the channel
    // to kick things off again.
    protInst->mSuspendedWrite = false;
    protInst->mAsyncOutStream->AsyncWait(protInst->mProvider, 0, 0,
                                         protInst->mProviderThread);
  }

  return NS_OK;
}

NS_IMPL_ADDREF_INHERITED(nsMsgAsyncWriteProtocol, nsMsgProtocol)
NS_IMPL_RELEASE_INHERITED(nsMsgAsyncWriteProtocol, nsMsgProtocol)

NS_INTERFACE_MAP_BEGIN(nsMsgAsyncWriteProtocol)
  NS_INTERFACE_MAP_ENTRY(nsISupportsWeakReference)
NS_INTERFACE_MAP_END_INHERITING(nsMsgProtocol)

nsMsgAsyncWriteProtocol::nsMsgAsyncWriteProtocol(nsIURI* aURL)
    : nsMsgProtocol(aURL) {
  mSuspendedWrite = false;
  mSuspendedReadBytes = 0;
  mSuspendedRead = false;
  mInsertPeriodRequired = false;
  mGenerateProgressNotifications = false;
  mSuspendedReadBytesPostPeriod = 0;
  mFilePostHelper = nullptr;
}

nsMsgAsyncWriteProtocol::~nsMsgAsyncWriteProtocol() {}

NS_IMETHODIMP nsMsgAsyncWriteProtocol::Cancel(nsresult status) {
  mGenerateProgressNotifications = false;

  if (m_proxyRequest) {
    m_proxyRequest->Cancel(status);
  }

  if (m_request) m_request->Cancel(status);

  if (mAsyncOutStream) mAsyncOutStream->CloseWithStatus(status);

  return NS_OK;
}

nsresult nsMsgAsyncWriteProtocol::PostMessage(nsIURI* url, nsIFile* file) {
  nsCOMPtr<nsIStreamListener> listener = new nsMsgFilePostHelper();

  if (!listener) return NS_ERROR_OUT_OF_MEMORY;

  // be sure to initialize some state before posting
  mSuspendedReadBytes = 0;
  mNumBytesPosted = 0;
  file->GetFileSize(&mFilePostSize);
  mSuspendedRead = false;
  mInsertPeriodRequired = false;
  mSuspendedReadBytesPostPeriod = 0;
  mGenerateProgressNotifications = true;

  mFilePostHelper = static_cast<nsMsgFilePostHelper*>(
      static_cast<nsIStreamListener*>(listener));

  static_cast<nsMsgFilePostHelper*>(static_cast<nsIStreamListener*>(listener))
      ->Init(m_outputStream, this, file);

  return NS_OK;
}

nsresult nsMsgAsyncWriteProtocol::SuspendPostFileRead() {
  if (mFilePostHelper && !mFilePostHelper->mSuspendedPostFileRead) {
    // uhoh we need to pause reading in the file until we get unblocked...
    mFilePostHelper->mPostFileRequest->Suspend();
    mFilePostHelper->mSuspendedPostFileRead = true;
  }

  return NS_OK;
}

nsresult nsMsgAsyncWriteProtocol::ResumePostFileRead() {
  if (mFilePostHelper) {
    if (mFilePostHelper->mSuspendedPostFileRead) {
      mFilePostHelper->mPostFileRequest->Resume();
      mFilePostHelper->mSuspendedPostFileRead = false;
    }
  } else  // we must be done with the download so send the '.'
  {
    PostDataFinished();
  }

  return NS_OK;
}

nsresult nsMsgAsyncWriteProtocol::UpdateSuspendedReadBytes(
    uint32_t aNewBytes, bool aAddToPostPeriodByteCount) {
  // depending on our current state, we'll either add aNewBytes to
  // mSuspendedReadBytes or mSuspendedReadBytesAfterPeriod.

  mSuspendedRead = true;
  if (aAddToPostPeriodByteCount)
    mSuspendedReadBytesPostPeriod += aNewBytes;
  else
    mSuspendedReadBytes += aNewBytes;

  return NS_OK;
}

nsresult nsMsgAsyncWriteProtocol::PostDataFinished() {
  nsresult rv = SendData("." CRLF);
  if (NS_FAILED(rv)) return rv;
  mGenerateProgressNotifications = false;
  mPostDataStream = nullptr;
  return NS_OK;
}

nsresult nsMsgAsyncWriteProtocol::ProcessIncomingPostData(nsIInputStream* inStr,
                                                          uint32_t count) {
  if (!m_socketIsOpen) return NS_OK;  // kick out if the socket was canceled

  // We need to quote any '.' that occur at the beginning of a line.
  // but I don't want to waste time reading out the data into a buffer and
  // searching let's try to leverage nsIBufferedInputStream and see if we can
  // "peek" into the current contents for this particular case.

  nsCOMPtr<nsISearchableInputStream> bufferInputStr = do_QueryInterface(inStr);
  NS_ASSERTION(
      bufferInputStr,
      "i made a wrong assumption about the type of stream we are getting");
  NS_ASSERTION(mSuspendedReadBytes == 0, "oops, I missed something");

  if (!mPostDataStream) mPostDataStream = inStr;

  if (bufferInputStr) {
    uint32_t amountWritten;

    while (count > 0) {
      bool found = false;
      uint32_t offset = 0;
      bufferInputStr->Search("\012.", true, &found, &offset);  // LF.

      if (!found || offset > count) {
        // push this data into the output stream
        m_outputStream->WriteFrom(inStr, count, &amountWritten);
        // store any remains which need read out at a later date
        if (count > amountWritten)  // stream will block
        {
          UpdateSuspendedReadBytes(count - amountWritten, false);
          SuspendPostFileRead();
        }
        break;
      } else {
        // count points to the LF in a LF followed by a '.'
        // go ahead and write up to offset..
        m_outputStream->WriteFrom(inStr, offset + 1, &amountWritten);
        count -= amountWritten;
        if (offset + 1 > amountWritten) {
          UpdateSuspendedReadBytes(offset + 1 - amountWritten, false);
          mInsertPeriodRequired = true;
          UpdateSuspendedReadBytes(count, mInsertPeriodRequired);
          SuspendPostFileRead();
          break;
        }

        // write out the extra '.'
        m_outputStream->Write(".", 1, &amountWritten);
        if (amountWritten != 1) {
          mInsertPeriodRequired = true;
          // once we do write out the '.',  if we are now blocked we need to
          // remember the remaining count that comes after the '.' so we can
          // perform processing on that once we become unblocked.
          UpdateSuspendedReadBytes(count, mInsertPeriodRequired);
          SuspendPostFileRead();
          break;
        }
      }
    }  // while count > 0
  }

  return NS_OK;
}
nsresult nsMsgAsyncWriteProtocol::UnblockPostReader() {
  uint32_t amountWritten = 0;

  if (!m_socketIsOpen) return NS_OK;  // kick out if the socket was canceled

  if (mSuspendedRead) {
    // (1) attempt to write out any remaining read bytes we need in order to
    // unblock the reader
    if (mSuspendedReadBytes > 0 && mPostDataStream) {
      uint64_t avail = 0;
      mPostDataStream->Available(&avail);

      m_outputStream->WriteFrom(mPostDataStream,
                                std::min(avail, uint64_t(mSuspendedReadBytes)),
                                &amountWritten);
      // hmm sometimes my mSuspendedReadBytes is getting out of whack...so for
      // now, reset it if necessary.
      if (mSuspendedReadBytes > avail) mSuspendedReadBytes = avail;

      if (mSuspendedReadBytes > amountWritten)
        mSuspendedReadBytes -= amountWritten;
      else
        mSuspendedReadBytes = 0;
    }

    // (2) if we are now unblocked, and we need to insert a '.' then do so
    // now...
    if (mInsertPeriodRequired && mSuspendedReadBytes == 0) {
      amountWritten = 0;
      m_outputStream->Write(".", 1, &amountWritten);
      if (amountWritten == 1)  // if we succeeded then clear pending '.' flag
        mInsertPeriodRequired = false;
    }

    // (3) if we inserted a '.' and we still have bytes after the '.' which need
    // processed before the stream is unblocked then fake an ODA call to handle
    // this now...
    if (!mInsertPeriodRequired && mSuspendedReadBytesPostPeriod > 0) {
      // these bytes actually need processed for extra '.''s.....
      uint32_t postbytes = mSuspendedReadBytesPostPeriod;
      mSuspendedReadBytesPostPeriod = 0;
      ProcessIncomingPostData(mPostDataStream, postbytes);
    }

    // (4) determine if we are out of the suspended read state...
    if (mSuspendedReadBytes == 0 && !mInsertPeriodRequired &&
        mSuspendedReadBytesPostPeriod == 0) {
      mSuspendedRead = false;
      ResumePostFileRead();
    }

  }  // if we are in the suspended read state

  return NS_OK;
}

nsresult nsMsgAsyncWriteProtocol::SetupTransportState() {
  nsresult rv = NS_OK;

  if (!m_outputStream && m_transport) {
    // first create a pipe which we'll use to write the data we want to send
    // into.
    nsCOMPtr<nsIPipe> pipe = do_CreateInstance("@mozilla.org/pipe;1");
    rv = pipe->Init(true, true, 1024, 8);
    NS_ENSURE_SUCCESS(rv, rv);

    nsIAsyncInputStream* inputStream = nullptr;
    // This always succeeds because the pipe is initialized above.
    MOZ_ALWAYS_SUCCEEDS(pipe->GetInputStream(&inputStream));
    mInStream = dont_AddRef(static_cast<nsIInputStream*>(inputStream));

    nsIAsyncOutputStream* outputStream = nullptr;
    // This always succeeds because the pipe is initialized above.
    MOZ_ALWAYS_SUCCEEDS(pipe->GetOutputStream(&outputStream));
    m_outputStream = dont_AddRef(static_cast<nsIOutputStream*>(outputStream));

    mProviderThread = do_GetCurrentThread();

    nsMsgProtocolStreamProvider* provider = new nsMsgProtocolStreamProvider();

    if (!provider) return NS_ERROR_OUT_OF_MEMORY;

    provider->Init(this, mInStream);
    mProvider = provider;  // ADDREF

    nsCOMPtr<nsIOutputStream> stream;
    rv = m_transport->OpenOutputStream(0, 0, 0, getter_AddRefs(stream));
    if (NS_FAILED(rv)) return rv;

    mAsyncOutStream = do_QueryInterface(stream, &rv);
    if (NS_FAILED(rv)) return rv;

    // wait for the output stream to become writable
    rv = mAsyncOutStream->AsyncWait(mProvider, 0, 0, mProviderThread);
  }  // if m_transport

  return rv;
}

nsresult nsMsgAsyncWriteProtocol::CloseSocket() {
  nsresult rv = NS_OK;
  if (mAsyncOutStream) mAsyncOutStream->CloseWithStatus(NS_BINDING_ABORTED);

  nsMsgProtocol::CloseSocket();

  if (mFilePostHelper) {
    mFilePostHelper->CloseSocket();
    mFilePostHelper = nullptr;
  }

  mAsyncOutStream = nullptr;
  mProvider = nullptr;
  mProviderThread = nullptr;
  mAsyncBuffer.Truncate();
  return rv;
}

void nsMsgAsyncWriteProtocol::UpdateProgress(uint32_t aNewBytes) {
  if (!mGenerateProgressNotifications) return;

  mNumBytesPosted += aNewBytes;
  if (mFilePostSize > 0) {
    nsCOMPtr<nsIMsgMailNewsUrl> mailUrl = do_QueryInterface(m_url);
    if (!mailUrl) return;

    nsCOMPtr<nsIMsgStatusFeedback> statusFeedback;
    mailUrl->GetStatusFeedback(getter_AddRefs(statusFeedback));
    if (!statusFeedback) return;

    nsCOMPtr<nsIWebProgressListener> webProgressListener(
        do_QueryInterface(statusFeedback));
    if (!webProgressListener) return;

    // XXX not sure if m_request is correct here
    webProgressListener->OnProgressChange(nullptr, m_request, mNumBytesPosted,
                                          static_cast<uint32_t>(mFilePostSize),
                                          mNumBytesPosted, mFilePostSize);
  }

  return;
}

nsresult nsMsgAsyncWriteProtocol::SendData(const char* dataBuffer,
                                           bool aSuppressLogging) {
  this->mAsyncBuffer.Append(dataBuffer);
  if (!mAsyncOutStream) return NS_ERROR_FAILURE;
  return mAsyncOutStream->AsyncWait(mProvider, 0, 0, mProviderThread);
}

char16_t* FormatStringWithHostNameByName(const char16_t* stringName,
                                         nsIMsgMailNewsUrl* msgUri) {
  if (!msgUri) return nullptr;

  nsresult rv;

  nsCOMPtr<nsIStringBundleService> sBundleService =
      mozilla::services::GetStringBundleService();
  NS_ENSURE_TRUE(sBundleService, nullptr);

  nsCOMPtr<nsIStringBundle> sBundle;
  rv = sBundleService->CreateBundle(MSGS_URL, getter_AddRefs(sBundle));
  NS_ENSURE_SUCCESS(rv, nullptr);

  nsCOMPtr<nsIMsgIncomingServer> server;
  rv = msgUri->GetServer(getter_AddRefs(server));
  NS_ENSURE_SUCCESS(rv, nullptr);

  nsCString hostName;
  rv = server->GetRealHostName(hostName);
  NS_ENSURE_SUCCESS(rv, nullptr);

  AutoTArray<nsString, 1> params;
  CopyASCIItoUTF16(hostName, *params.AppendElement());
  nsAutoString str;
  rv = sBundle->FormatStringFromName(NS_ConvertUTF16toUTF8(stringName).get(),
                                     params, str);
  NS_ENSURE_SUCCESS(rv, nullptr);

  return ToNewUnicode(str);
}

// vim: ts=2 sw=2
