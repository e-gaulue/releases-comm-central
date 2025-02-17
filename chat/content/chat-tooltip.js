/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* global MozElements */
/* global MozXULElement */
/* global getBrowser */

// Wrap in a block to prevent leaking to window scope.
{
  let { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
  let { ChatIcons } = ChromeUtils.import("resource:///modules/chatIcons.jsm");
  const LazyModules = {};

  ChromeUtils.defineModuleGetter(
    LazyModules,
    "Status",
    "resource:///modules/imStatusUtils.jsm"
  );

  /**
   * The MozChatTooltip widget implements a custom tooltip for chat. This tooltip
   * is used to display a rich tooltip when you mouse over contacts, channels
   * etc. in the chat view.
   * @extends {XULPopupElement}
   */
  class MozChatTooltip extends MozElements.MozElementMixin(XULPopupElement) {
    static get inheritedAttributes() {
      return { ".displayName": "value=displayname" };
    }

    constructor() {
      super();
      this._buddy = null;

      this.observer = {
        // @see {nsIObserver}
        observe: (subject, topic, data) => {
          if (
            subject == this.buddy &&
            (topic == "account-buddy-status-changed" ||
              topic == "account-buddy-status-detail-changed" ||
              topic == "account-buddy-display-name-changed" ||
              topic == "account-buddy-icon-changed")
          ) {
            this.updateTooltipFromBuddy(this.buddy);
          } else if (
            topic == "user-info-received" &&
            data == this.observedUserInfo
          ) {
            this.updateTooltipInfo(
              subject.QueryInterface(Ci.nsISimpleEnumerator)
            );
          }
        },
        QueryInterface: ChromeUtils.generateQI([
          "nsIObserver",
          "nsISupportsWeakReference",
        ]),
      };

      this.addEventListener("popupshowing", event => {
        if (!this._onPopupShowing()) {
          event.preventDefault();
        }
      });

      this.addEventListener("popuphiding", event => {
        this.buddy = null;
        if ("observedUserInfo" in this && this.observedUserInfo) {
          Services.obs.removeObserver(this.observer, "user-info-received");
          delete this.observedUserInfo;
        }
      });
    }

    _onPopupShowing() {
      // No tooltip above the context menu.
      if (document.popupNode) {
        return false;
      }

      // No tooltip for elements that have already been removed.
      if (!document.tooltipNode.parentNode) {
        return false;
      }

      // Reset tooltip.
      let largeTooltip = this.querySelector(".largeTooltip");
      largeTooltip.hidden = false;
      this.removeAttribute("label");

      // We have a few cases that have special behavior. These are richlistitems
      // and have tooltip="<myid>".
      let item = document.tooltipNode.closest(
        `[tooltip="${this.id}"] richlistitem`
      );

      if (item && item.matches(`:scope[is="chat-group-richlistitem"]`)) {
        return false;
      }

      if (item && item.matches(`:scope[is="chat-imconv-richlistitem"]`)) {
        return this.updateTooltipFromConversation(item.conv);
      }

      if (item && item.matches(`:scope[is="chat-contact-richlistitem"]`)) {
        return this.updateTooltipFromBuddy(
          item.contact.preferredBuddy.preferredAccountBuddy
        );
      }

      if (item) {
        let contactlistbox = document.getElementById("contactlistbox");
        let conv = contactlistbox.selectedItem.conv;
        return this.updateTooltipFromParticipant(
          item.chatBuddy.name,
          conv,
          item.chatBuddy
        );
      }

      // Tooltips are also used for the chat content, where we need to do
      // some more general checks.
      let elt = document.tooltipNode;
      let classList = elt.classList;
      if (
        classList.contains("ib-nick") ||
        classList.contains("ib-sender") ||
        classList.contains("ib-person")
      ) {
        let conv = getBrowser()._conv;
        // ib-sender nicks are handled with _originalMsg
        if (conv.isChat && !classList.contains("ib-sender")) {
          return this.updateTooltipFromParticipant(elt.textContent, conv);
        }
        if (!conv.isChat && elt.textContent == conv.name) {
          return this.updateTooltipFromConversation(conv);
        }
      }

      // Are we over a message?
      for (let node = elt; node; node = node.parentNode) {
        if (!node._originalMsg) {
          continue;
        }
        // Nick, build tooltip with original who information from message
        if (classList.contains("ib-sender")) {
          let conv = getBrowser()._conv;
          if (conv.isChat) {
            return this.updateTooltipFromParticipant(
              node._originalMsg.who,
              conv
            );
          }
        }
        // It's a message, so add a date/time tooltip.
        let date = new Date(node._originalMsg.time * 1000);
        let text;
        if (new Date().toDateString() == date.toDateString()) {
          const dateTimeFormatter = new Services.intl.DateTimeFormat(
            undefined,
            {
              timeStyle: "medium",
            }
          );
          text = dateTimeFormatter.format(date);
        } else {
          const dateTimeFormatter = new Services.intl.DateTimeFormat(
            undefined,
            {
              dateStyle: "short",
              timeStyle: "medium",
            }
          );
          text = dateTimeFormatter.format(date);
        }
        // Setting the attribute on this node means that if the element
        // we are pointing at carries a title set by the prpl,
        // that title won't be overridden.
        node.setAttribute("title", text);
        break;
      }

      // Use the default content tooltip.
      largeTooltip.hidden = true;
      return false;
    }

    connectedCallback() {
      if (this.delayConnectedCallback()) {
        return;
      }
      this.textContent = "";
      this.appendChild(
        MozXULElement.parseXULToFragment(`
          <vbox class="largeTooltip">
            <html:div class="displayUserAccount tooltipDisplayUserAccount">
              <stack>
                <html:img class="userIcon" alt=""/>
                <html:img class="statusTypeIcon status" alt=""/>
              </stack>
              <html:div class="nameAndStatusGrid">
                <description class="displayName" crop="end"></description>
                <html:img class="protoIcon status" alt=""/>
                <html:hr />
                <description class="statusMessage" crop="end"></description>
              </html:div>
            </html:div>
            <html:table class="tooltipTable">
            </html:table>
          </vbox>
        `)
      );
      this.initializeAttributeInheritance();
    }

    get bundle() {
      if (!this._bundle) {
        this._bundle = Services.strings.createBundle(
          "chrome://chat/locale/imtooltip.properties"
        );
      }
      return this._bundle;
    }

    set buddy(val) {
      if (val == this._buddy) {
        return;
      }

      if (!val) {
        this._buddy.buddy.removeObserver(this.observer);
      } else {
        val.buddy.addObserver(this.observer);
      }

      this._buddy = val;
    }

    get buddy() {
      return this._buddy;
    }

    get table() {
      if (!("_table" in this)) {
        this._table = this.querySelector(".tooltipTable");
      }
      return this._table;
    }

    setMessage(aMessage, noTopic = false) {
      let msg = this.querySelector(".statusMessage");
      msg.value = aMessage;
      msg.toggleAttribute("noTopic", noTopic);
    }

    reset() {
      while (this.table.hasChildNodes()) {
        this.table.lastChild.remove();
      }
    }

    addRow(aLabel, aValue) {
      let description;
      let row = [...this.table.querySelectorAll("tr")].find(row => {
        return row.querySelector("th").textContent == aLabel;
      });
      if (!row) {
        // Create a new row for this label.
        row = document.createElementNS("http://www.w3.org/1999/xhtml", "tr");
        let th = document.createElementNS("http://www.w3.org/1999/xhtml", "th");
        th.textContent = aLabel;
        th.setAttribute("valign", "top");
        row.appendChild(th);
        description = document.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "td"
        );
        row.appendChild(description);
        this.table.appendChild(row);
      } else {
        // Row with this label already exists - just update.
        description = row.querySelector("td");
      }
      description.textContent = aValue;
    }

    addSeparator() {
      if (this.table.hasChildNodes()) {
        let lastElement = this.table.lastElementChild;
        lastElement.querySelector("th").classList.add("chatTooltipSeparator");
        lastElement.querySelector("td").classList.add("chatTooltipSeparator");
      }
    }

    requestBuddyInfo(aAccount, aObservedName) {
      // Libpurple prpls don't necessarily return data in response to
      // requestBuddyInfo that is suitable for displaying inside a
      // tooltip (e.g. too many objects, or <img> and <a> tags),
      // so we only use it for JavaScript prpls.
      // This is a terrible, terrible hack to work around the fact that
      // ClassInfo.implementationLanguage has gone.
      if (!aAccount.prplAccount || !aAccount.prplAccount.wrappedJSObject) {
        return;
      }
      this.observedUserInfo = aObservedName;
      Services.obs.addObserver(this.observer, "user-info-received");
      aAccount.requestBuddyInfo(aObservedName);
    }

    /**
     * Sets the shown user icon.
     *
     * @param {string|null} iconURI - The image uri to show, or "" to use the
     *   fallback, or null to hide the icon.
     * @param {boolean} useFallback - True if the "fallback" icon should be shown
     *   if iconUri isn't provided.
     */
    setUserIcon(iconUri, useFalback) {
      ChatIcons.setUserIconSrc(
        this.querySelector(".userIcon"),
        iconUri,
        useFalback
      );
    }

    setProtocolIcon(protocol) {
      this.querySelector(".protoIcon").setAttribute(
        "src",
        ChatIcons.getProtocolIconURI(protocol)
      );
    }

    setStatusIcon(statusName) {
      this.querySelector(".statusTypeIcon").setAttribute(
        "src",
        ChatIcons.getStatusIconURI(statusName)
      );
      ChatIcons.setProtocolIconOpacity(
        this.querySelector(".protoIcon"),
        statusName
      );
    }

    /**
     * Regenerate the tooltip based on a buddy.
     *
     * @param {prplIAccountBuddy} aBuddy - The buddy to generate the conversation.
     * @param {imIConversation} [aConv] - A conversation associated with this buddy.
     */
    updateTooltipFromBuddy(aBuddy, aConv) {
      this.buddy = aBuddy;

      this.reset();
      let name = aBuddy.userName;
      let displayName = aBuddy.displayName;
      this.setAttribute("displayname", displayName);
      let account = aBuddy.account;
      this.setProtocolIcon(account.protocol);
      // If a conversation is provided, use the icon from it. Otherwise, use the
      // buddy icon filename.
      if (aConv) {
        this.setUserIcon(aConv.convIconFilename, true);
      } else {
        this.setUserIcon(aBuddy.buddyIconFilename, true);
      }

      let statusType = aBuddy.statusType;
      this.setStatusIcon(LazyModules.Status.toAttribute(statusType));
      this.setMessage(
        LazyModules.Status.toLabel(statusType, aBuddy.statusText)
      );

      if (displayName != name) {
        this.addRow(this.bundle.GetStringFromName("buddy.username"), name);
      }

      this.addRow(this.bundle.GetStringFromName("buddy.account"), account.name);

      // Add encryption status.
      if (document.tooltipNode.classList.contains("message-encrypted")) {
        this.addRow(
          this.bundle.GetStringFromName("otr.tag"),
          this.bundle.GetStringFromName("message.status")
        );
      }

      this.requestBuddyInfo(account, aBuddy.normalizedName);

      let tooltipInfo = aBuddy.getTooltipInfo();
      if (tooltipInfo) {
        this.updateTooltipInfo(tooltipInfo);
      }
      return true;
    }

    updateTooltipInfo(aTooltipInfo) {
      for (let elt of aTooltipInfo) {
        switch (elt.type) {
          case Ci.prplITooltipInfo.pair:
          case Ci.prplITooltipInfo.sectionHeader:
            this.addRow(elt.label, elt.value);
            break;
          case Ci.prplITooltipInfo.sectionBreak:
            this.addSeparator();
            break;
          case Ci.prplITooltipInfo.status:
            let statusType = parseInt(elt.label);
            this.setStatusIcon(LazyModules.Status.toAttribute(statusType));
            this.setMessage(LazyModules.Status.toLabel(statusType, elt.value));
            break;
          case Ci.prplITooltipInfo.icon:
            this.setUserIcon(elt.value);
            break;
        }
      }
    }

    /**
     * Regenerate the tooltip based on a conversation.
     *
     * @param {imIConversation} aConv - The conversation to generate the tooltip from.
     */
    updateTooltipFromConversation(aConv) {
      if (!aConv.isChat && aConv.buddy) {
        return this.updateTooltipFromBuddy(aConv.buddy, aConv);
      }

      this.reset();
      this.setAttribute("displayname", aConv.name);
      let account = aConv.account;
      this.setProtocolIcon(account.protocol);
      // Set the icon, potentially showing a fallback icon if this is an IM.
      this.setUserIcon(aConv.convIconFilename, !aConv.isChat);
      if (aConv.isChat) {
        if (!account.connected || aConv.left) {
          this.setStatusIcon("chat-left");
        } else {
          this.setStatusIcon("chat");
        }
        let topic = aConv.topic;
        let noTopic = !topic;
        this.setMessage(topic || aConv.noTopicString, noTopic);
      } else {
        this.setStatusIcon("unknown");
        this.setMessage(LazyModules.Status.toLabel("unknown"));
        // Last ditch attempt to get some tooltip info. This call relies on
        // the account's requestBuddyInfo implementation working correctly
        // with aConv.normalizedName.
        this.requestBuddyInfo(account, aConv.normalizedName);
      }
      this.addRow(this.bundle.GetStringFromName("buddy.account"), account.name);
      return true;
    }

    updateTooltipFromParticipant(aNick, aConv, aParticipant) {
      if (!aConv.target) {
        return false; // We're viewing a log.
      }
      if (!aParticipant) {
        aParticipant = aConv.target.getParticipant(aNick);
      }

      let account = aConv.account;
      let normalizedNick = aConv.target.getNormalizedChatBuddyName(aNick);
      // To try to ensure that we aren't misidentifying a nick with a
      // contact, we require at least that the normalizedChatBuddyName of
      // the nick is normalized like a normalizedName for contacts.
      if (normalizedNick == account.normalize(normalizedNick)) {
        let accountBuddy = Services.contacts.getAccountBuddyByNameAndAccount(
          normalizedNick,
          account
        );
        if (accountBuddy) {
          return this.updateTooltipFromBuddy(accountBuddy);
        }
      }

      this.reset();
      this.setAttribute("displayname", aNick);
      this.setProtocolIcon(account.protocol);
      this.setStatusIcon("unknown");
      this.setMessage(LazyModules.Status.toLabel("unknown"));
      this.setUserIcon(aParticipant?.buddyIconFilename, true);

      this.requestBuddyInfo(account, normalizedNick);
      return true;
    }
  }
  customElements.define("chat-tooltip", MozChatTooltip, { extends: "tooltip" });
}
