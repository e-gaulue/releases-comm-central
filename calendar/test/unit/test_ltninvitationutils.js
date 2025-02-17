/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { ltn } = ChromeUtils.import("resource:///modules/calendar/ltnInvitationUtils.jsm");
var { MailServices } = ChromeUtils.import("resource:///modules/MailServices.jsm");
var { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
var { XPCOMUtils } = ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyModuleGetters(this, {
  CalAttendee: "resource:///modules/CalAttendee.jsm",
});

function run_test() {
  do_calendar_startup(run_next_test);
}

// tests for ltnInvitationUtils.jsm

function getIcs(aAsArray = false) {
  // we use an unfolded ics blueprint here to make replacing of properties easier
  let item = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Mozilla.org/NONSGML Mozilla Calendar V1.1//EN",
    "VERSION:2.0",
    "METHOD:REQUEST",
    "BEGIN:VTIMEZONE",
    "TZID:Europe/Berlin",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0200",
    "TZNAME:CEST",
    "DTSTART:19700329T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0200",
    "TZOFFSETTO:+0100",
    "TZNAME:CET",
    "DTSTART:19701025T030000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    "CREATED:20150909T180909Z",
    "LAST-MODIFIED:20150909T181048Z",
    "DTSTAMP:20150909T181048Z",
    "UID:cb189fdc-ed47-4db6-a8d7-31a08802249d",
    "SUMMARY:Test Event",
    "ORGANIZER;RSVP=TRUE;CN=Organizer;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:organizer@example.net",
    "ATTENDEE;RSVP=TRUE;CN=Attendee;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:mailto:attende" +
      "e@example.net",
    "DTSTART;TZID=Europe/Berlin:20150909T210000",
    "DTEND;TZID=Europe/Berlin:20150909T220000",
    "SEQUENCE:1",
    "TRANSP:OPAQUE",
    "LOCATION:Room 1",
    "DESCRIPTION:Let us get together",
    "URL:http://www.example.com",
    "ATTACH:http://www.example.com",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  if (!aAsArray) {
    item = item.join("\r\n");
  }
  return item;
}

add_task(async function getItipHeader_test() {
  let data = [
    {
      input: {
        method: "METHOD:REQUEST\r\n",
        attendees: [null],
      },
      expected: "Organizer has invited you to Test Event",
    },
    {
      input: {
        method: "METHOD:CANCEL\r\n",
        attendees: [null],
      },
      expected: "Organizer has canceled this event: Test Event",
    },
    {
      input: {
        method: "METHOD:DECLINECOUNTER\r\n",
        attendees: [
          "ATTENDEE;RSVP=TRUE;CN=Attendee1;PARTSTAT=ACCEPTED;" +
            "ROLE=REQ-PARTICIPANT:mailto:attendee1@example.net",
        ],
      },
      expected: 'Organizer has declined your counterproposal for "Test Event".',
    },
    {
      input: {
        method: "METHOD:COUNTER\r\n",
        attendees: [
          "ATTENDEE;RSVP=TRUE;CN=Attendee1;PARTSTAT=DECLINED;" +
            "ROLE=REQ-PARTICIPANT:mailto:attendee1@example.net",
        ],
      },
      expected: 'Attendee1 <attendee1@example.net> has made a counterproposal for "Test Event":',
    },
    {
      input: {
        method: "METHOD:REPLY\r\n",
        attendees: [
          "ATTENDEE;RSVP=TRUE;CN=Attendee1;PARTSTAT=ACCEPTED;" +
            "ROLE=REQ-PARTICIPANT:mailto:attendee1@example.net",
        ],
      },
      expected: "Attendee1 <attendee1@example.net> has accepted your event invitation.",
    },
    {
      input: {
        method: "METHOD:REPLY\r\n",
        attendees: [
          "ATTENDEE;RSVP=TRUE;CN=Attendee1;PARTSTAT=TENTATIVE;" +
            "ROLE=REQ-PARTICIPANT:mailto:attendee1@example.net",
        ],
      },
      expected: "Attendee1 <attendee1@example.net> has accepted your event invitation.",
    },
    {
      input: {
        method: "METHOD:REPLY\r\n",
        attendees: [
          "ATTENDEE;RSVP=TRUE;CN=Attendee1;PARTSTAT=DECLINED;" +
            "ROLE=REQ-PARTICIPANT:mailto:attendee1@example.net",
        ],
      },
      expected: "Attendee1 <attendee1@example.net> has declined your event invitation.",
    },
    {
      input: {
        method: "METHOD:REPLY\r\n",
        attendees: [
          "ATTENDEE;RSVP=TRUE;CN=Attendee1;PARTSTAT=ACCEPTED;" +
            "ROLE=REQ-PARTICIPANT:mailto:attendee1@example.net",
          "ATTENDEE;RSVP=TRUE;CN=Attendee2;PARTSTAT=DECLINED;" +
            "ROLE=REQ-PARTICIPANT:mailto:attendee2@example.net",
        ],
      },
      expected: "Attendee1 <attendee1@example.net> has accepted your event invitation.",
    },
    {
      input: {
        method: "METHOD:UNSUPPORTED\r\n",
        attendees: [null],
      },
      expected: "Event Invitation",
    },
    {
      input: {
        method: "",
        attendees: [""],
      },
      expected: "Event Invitation",
    },
  ];
  let i = 0;
  for (let test of data) {
    i++;
    let itipItem = Cc["@mozilla.org/calendar/itip-item;1"].createInstance(Ci.calIItipItem);
    let item = getIcs();
    let sender;
    if (test.input.method || test.input.method == "") {
      item = item.replace(/METHOD:REQUEST\r\n/, test.input.method);
    }
    if (test.input.attendees.length) {
      let attendees = test.input.attendees.filter(aAtt => !!aAtt).join("\r\n");
      item = item.replace(/(ATTENDEE.+(?:\r\n))/, attendees + "\r\n");
      if (test.input.attendees[0]) {
        sender = new CalAttendee();
        sender.icalString = test.input.attendees[0];
      }
    }
    itipItem.init(item);
    if (sender) {
      itipItem.sender = sender.id;
    }
    equal(ltn.invitation.getItipHeader(itipItem), test.expected, "(test #" + i + ")");
  }
});

add_task(async function createInvitationOverlay_test() {
  let data = [
    {
      input: { description: "DESCRIPTION:Go to https://www.example.net if you can.\r\n" },
      expected: {
        node: "imipHtml-description-content",
        value:
          'Go to <a xmlns="http://www.w3.org/1999/xhtml" class="moz-txt-link-freetext' +
          '" href="https://www.example.net">https://www.example.net</a> if you can.',
      },
    },
    {
      input: { description: "DESCRIPTION:Go to www.example.net if you can.\r\n" },
      expected: {
        node: "imipHtml-description-content",
        value:
          'Go to <a xmlns="http://www.w3.org/1999/xhtml" class="moz-txt-link-abbrevia' +
          'ted" href="http://www.example.net">www.example.net</a> if you can.',
      },
    },
    {
      input: { description: "DESCRIPTION:Let's see if +/- still can be displayed.\r\n" },
      expected: {
        node: "imipHtml-description-content",
        value: "Let's see if +/- still can be displayed.",
      },
    },
    {
      input: { description: "DESCRIPTION:Or write to mailto:faq@example.net instead.\r\n" },
      expected: {
        node: "imipHtml-description-content",
        value:
          'Or write to <a xmlns="http://www.w3.org/1999/xhtml" class="moz-txt-link-fr' +
          'eetext" href="mailto:faq@example.net">mailto:faq@example.net</a> instead.',
      },
    },
    {
      input: { description: "DESCRIPTION:Or write to faq@example.net instead.\r\n" },
      expected: {
        node: "imipHtml-description-content",
        value:
          'Or write to <a xmlns="http://www.w3.org/1999/xhtml" class="moz-txt-link-ab' +
          'breviated" href="mailto:faq@example.net">faq@example.net</a> instead.',
      },
    },
    {
      input: { description: "DESCRIPTION:It's up to you ;-)\r\n" },
      expected: {
        node: "imipHtml-description-content",
        value: "It's up to you ;-)",
      },
    },
    {
      input: {
        description:
          "DESCRIPTION:Let's see how evil we can be: <script language=\"JavaScript" +
          '">document.getElementById("imipHtml-description-content").write("Sc' +
          'ript embedded!")</script>\r\n',
      },
      expected: {
        node: "imipHtml-description-content",
        value: "Let's see how evil we can be: ",
      },
    },
    {
      input: {
        description:
          'DESCRIPTION:Or we can try: <img src="document.getElementById("imipHtm' +
          'l-description-descr").innerText" >\r\n',
      },
      expected: {
        node: "imipHtml-description-content",
        value: "Or we can try: ",
      },
    },
    {
      input: {
        description:
          'DESCRIPTION:Check <a href="http://example.com">example.com</a>&nbsp;&nbsp;&mdash; only 3 &euro;\r\n',
      },
      expected: {
        node: "imipHtml-description-content",
        value:
          'Check <a xmlns="http://www.w3.org/1999/xhtml" href="http://example.com">example.com</a>  \u2014 only 3 €',
      },
    },
    {
      input: { url: "URL:http://www.example.org/event.ics\r\n" },
      expected: {
        node: "imipHtml-url-content",
        value:
          '<a xmlns="http://www.w3.org/1999/xhtml" class="moz-txt-link-freetext" hre' +
          'f="http://www.example.org/event.ics">http://www.example.org/event.ics</a>',
      },
    },
    {
      input: { attach: "ATTACH:http://www.example.org\r\n" },
      expected: {
        node: "imipHtml-attachments-content",
        value:
          '<a xmlns="http://www.w3.org/1999/xhtml" class="moz-txt-link-freetext" hre' +
          'f="http://www.example.org/">http://www.example.org/</a>',
      },
    },
    {
      input: {
        attach:
          "ATTACH;FMTTYPE=text/plain;ENCODING=BASE64;VALUE=BINARY:VGhlIHF1aWNrIGJyb3duI" +
          "GZveCBqdW1wcyBvdmVyIHRoZSBsYXp5IGRvZy4\r\n",
      },
      expected: {
        node: "imipHtml-attachments-content",
        value: "",
      },
    },
    {
      input: {
        attach:
          "ATTACH:http://www.example.org/first/\r\n" +
          "ATTACH:http://www.example.org/second\r\n" +
          "ATTACH:file:///N:/folder/third.file\r\n",
      },
      expected: {
        node: "imipHtml-attachments-content",
        value:
          '<a xmlns="http://www.w3.org/1999/xhtml" class="moz-txt-link-freetext" ' +
          'href="http://www.example.org/first/">http://www.example.org/first/</a>' +
          '<br xmlns="http://www.w3.org/1999/xhtml" />' +
          '<a xmlns="http://www.w3.org/1999/xhtml" class="moz-txt-link-freetext" ' +
          'href="http://www.example.org/second">http://www.example.org/second</a>' +
          '<br xmlns="http://www.w3.org/1999/xhtml" />' +
          '<a xmlns="http://www.w3.org/1999/xhtml" class="moz-txt-link-freetext">' +
          "file:///N:/folder/third.file</a>",
      },
    },
    {
      input: {
        attendee:
          "ATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION;ROLE=OPT-PARTICIPANT;CUTYPE=INDIV" +
          'IDUAL;CN="Attendee 1":mailto:attendee1@example.net\r\n' +
          "ATTENDEE;RSVP=TRUE;PARTSTAT=ACCEPTED;ROLE=NON-PARTICIPANT;CUTYPE=GROUP:mai" +
          "lto:attendee2@example.net\r\n" +
          "ATTENDEE;RSVP=TRUE;PARTSTAT=TENTATIVE;ROLE=REQ-PARTICIPANT;CUTYPE=RESOURCE" +
          ":mailto:attendee3@example.net\r\n" +
          "ATTENDEE;RSVP=TRUE;PARTSTAT=DECLINED;ROLE=OPT-PARTICIPANT;DELEGATED-FROM=" +
          '"mailto:attendee5@example.net";CUTYPE=ROOM:mailto:attendee4@example.' +
          "net\r\n" +
          'ATTENDEE;RSVP=TRUE;PARTSTAT=DELEGATED;ROLE=OPT-PARTICIPANT;DELEGATED-TO="' +
          'mailto:attendee4@example.net";CUTYPE=UNKNOWN:mailto:attendee5@example.net' +
          "\r\n" +
          "ATTENDEE;RSVP=TRUE:mailto:attendee6@example.net\r\n" +
          "ATTENDEE:mailto:attendee7@example.net\r\n",
      },
      expected: {
        node: "imipHtml-attendees-cell",
        values: [
          {
            name: "Attendee 1 <attendee1@example.net>",
            title:
              "Attendee 1 <attendee1@example.net> is an optional " +
              "participant. Attendee 1 still needs to reply.",
            icon: {
              role: "OPT-PARTICIPANT",
              usertype: "INDIVIDUAL",
              partstat: "NEEDS-ACTION",
            },
          },
          {
            name: "attendee2@example.net",
            title:
              "attendee2@example.net (group) is a non-participant. " +
              "attendee2@example.net has confirmed attendance.",
            icon: {
              role: "NON-PARTICIPANT",
              usertype: "GROUP",
              partstat: "ACCEPTED",
            },
          },
          {
            name: "attendee3@example.net",
            title:
              "attendee3@example.net (resource) is a required " +
              "participant. attendee3@example.net has confirmed attendance " +
              "tentatively.",
            icon: {
              role: "REQ-PARTICIPANT",
              usertype: "RESOURCE",
              partstat: "TENTATIVE",
            },
          },
          {
            name: "attendee4@example.net (delegated from attendee5@example.net)",
            title:
              "attendee4@example.net (room) is an optional participant. " +
              "attendee4@example.net has declined attendance.",
            icon: {
              role: "OPT-PARTICIPANT",
              usertype: "ROOM",
              partstat: "DECLINED",
            },
          },
          {
            name: "attendee5@example.net",
            title:
              "attendee5@example.net is an optional participant. " +
              "attendee5@example.net has delegated attendance to " +
              "attendee4@example.net.",
            icon: {
              role: "OPT-PARTICIPANT",
              usertype: "UNKNOWN",
              partstat: "DELEGATED",
            },
          },
          {
            name: "attendee6@example.net",
            title:
              "attendee6@example.net is a required participant. " +
              "attendee6@example.net still needs to reply.",
            icon: {
              role: "REQ-PARTICIPANT",
              usertype: "INDIVIDUAL",
              partstat: "NEEDS-ACTION",
            },
          },
          {
            name: "attendee7@example.net",
            title:
              "attendee7@example.net is a required participant. " +
              "attendee7@example.net still needs to reply.",
            icon: {
              role: "REQ-PARTICIPANT",
              usertype: "INDIVIDUAL",
              partstat: "NEEDS-ACTION",
            },
          },
        ],
      },
    },
    {
      input: {
        organizer:
          'ORGANIZER;PARTSTAT=ACCEPTED;ROLE=CHAIR;CUTYPE="INDIVIDUAL";CN="The Org' +
          'anizer":mailto:organizer@example.net\r\n',
      },
      expected: {
        node: "imipHtml-organizer-cell",
        values: [
          {
            name: "The Organizer <organizer@example.net>",
            title:
              "The Organizer <organizer@example.net> chairs the event. " +
              "The Organizer has confirmed attendance.",
            icon: {
              role: "CHAIR",
              usertype: "INDIVIDUAL",
              partstat: "ACCEPTED",
            },
          },
        ],
      },
    },
  ];
  let i = 0;
  for (let test of data) {
    i++;
    let item = getIcs();
    for (let attribute of Object.keys(test.input)) {
      switch (attribute) {
        case "description":
          item = item.replace(/DESCRIPTION:[^\r]+\r\n/, test.input.description);
          break;
        case "attendee":
          item = item.replace(/ATTENDEE;[^\r]+\r\n/, test.input.attendee);
          break;
        case "organizer":
          item = item.replace(/ORGANIZER;[^\r]+\r\n/, test.input.organizer);
          break;
        case "attach":
          item = item.replace(/ATTACH:[^\r]+\r\n/, test.input.attach);
          break;
        case "url":
          item = item.replace(/URL:[^\r]+\r\n/, test.input.url);
          break;
      }
    }
    let itipItem = Cc["@mozilla.org/calendar/itip-item;1"].createInstance(Ci.calIItipItem);
    itipItem.init(item);
    let parser = Cc["@mozilla.org/calendar/ics-parser;1"].createInstance(Ci.calIIcsParser);
    parser.parseString(item);
    let dom = ltn.invitation.createInvitationOverlay(parser.getItems()[0], itipItem);
    // we remove line-breaks and leading white spaces here so we can keep expected test results
    // above more comprehensive
    switch (test.expected.node) {
      case "imipHtml-organizer-cell":
      case "imipHtml-attendees-cell":
        let attendeeNodes = Array.from(
          dom.querySelectorAll(`#${test.expected.node} .attendee-label`)
        );
        equal(attendeeNodes.length, test.expected.values.length);
        for (let { name, title, icon } of test.expected.values) {
          let index = attendeeNodes.findIndex(el => el.textContent === name);
          ok(index !== -1, `Attendee with name ${name}`);
          let node = attendeeNodes.splice(index, 1)[0];
          equal(node.getAttribute("title"), title, `Title for ${name}`);
          let nodeIcon = node.querySelector(".itip-icon");
          ok(nodeIcon, `icon for ${name}`);
          for (let attr in icon) {
            equal(nodeIcon.getAttribute(attr), icon[attr], `${attr} for icon for ${name}`);
          }
        }
        break;
      default:
        let observed = dom.getElementById(test.expected.node).innerHTML;
        equal(observed, test.expected.value, "(test #" + i + ")");
        break;
    }
  }
});

add_task(async function compareInvitationOverlay_test() {
  // eventually it would make sense to set local timezone to Europe/Berlin to avoid test
  // failures when executing in a different timezone
  function getDom(aInput) {
    let item = getIcs();
    let props = ["attendee", "organizer", "dtstart", "dtend", "summary", "location"];
    for (let prop of props) {
      if (Object.keys(aInput).includes(prop)) {
        let regex =
          prop.toUpperCase() + (["summary", "location"].includes(prop) ? ":" : ";") + "[^\r]+\r\n";
        item = item.replace(new RegExp(regex), aInput[prop]);
      }
    }
    let itipItem = Cc["@mozilla.org/calendar/itip-item;1"].createInstance(Ci.calIItipItem);
    itipItem.init(item);
    let parser = Cc["@mozilla.org/calendar/ics-parser;1"].createInstance(Ci.calIIcsParser);
    parser.parseString(item);
    let dom = ltn.invitation.createInvitationOverlay(parser.getItems()[0], itipItem);
    return cal.xml.serializeDOM(dom);
  }
  let data = [
    {
      input: {
        previous: { location: "LOCATION:This place\r\n" },
        current: { location: "LOCATION:Another location\r\n" },
      },
      expected: {
        node: "imipHtml-location-content",
        ins: ["Another location"],
        del: ["This place"],
        mod: [],
      },
    },
    {
      input: {
        previous: { summary: "SUMMARY:My invitation\r\n" },
        current: { summary: "SUMMARY:My new invitation\r\n" },
      },
      expected: {
        node: "imipHtml-summary-content",
        ins: ["My new invitation"],
        del: ["My invitation"],
        mod: [],
      },
    },
    {
      input: {
        previous: {
          dtstart: "DTSTART;TZID=Europe/Berlin:20150909T130000\r\n",
          dtend: "DTEND;TZID=Europe/Berlin:20150909T140000\r\n",
        },
        current: {
          dtstart: "DTSTART;TZID=Europe/Berlin:20150909T140000\r\n",
          dtend: "DTEND;TZID=Europe/Berlin:20150909T150000\r\n",
        },
      },
      expected: {
        // Time format is platform dependent, so we use alternative result sets here.
        // The first two are configurations running for automated tests.
        // If you get a failure for this test, add your pattern here.
        node: "imipHtml-when-content",
        // For Windows.
        ins: [/^Wednesday, (September 0?9,|0?9 September) 2015 (2:00 PM – 3:00 PM|14:00 – 15:00)$/],
        del: [/^Wednesday, (September 0?9,|0?9 September) 2015 (1:00 PM – 2:00 PM|13:00 – 14:00)$/],
        mod: [],
      },
    },
    {
      input: {
        previous: { organizer: "ORGANIZER:mailto:organizer1@example.net\r\n" },
        current: { organizer: "ORGANIZER:mailto:organizer2@example.net\r\n" },
      },
      expected: {
        node: "imipHtml-organizer-cell",
        ins: ["organizer2@example.net"],
        del: ["organizer1@example.net"],
        mod: [],
      },
    },
    {
      input: {
        previous: {
          attendee:
            "ATTENDEE;RSVP=TRUE;CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION:" +
            "mailto:attendee1@example.net\r\n" +
            "ATTENDEE;RSVP=TRUE;CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION:" +
            "mailto:attendee2@example.net\r\n" +
            "ATTENDEE;RSVP=TRUE;CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION:" +
            "mailto:attendee3@example.net\r\n",
        },
        current: {
          attendee:
            "ATTENDEE;RSVP=TRUE;CUTYPE=INDIVIDUAL;PARTSTAT=ACCEPTED:mail" +
            "to:attendee2@example.net\r\n" +
            "ATTENDEE;RSVP=TRUE;CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION:" +
            "mailto:attendee3@example.net\r\n" +
            "ATTENDEE;RSVP=TRUE;CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION:" +
            "mailto:attendee4@example.net\r\n",
        },
      },
      expected: {
        node: "imipHtml-attendees-cell",
        ins: ["attendee4@example.net"],
        del: ["attendee1@example.net"],
        mod: ["attendee2@example.net"],
      },
    },
  ];
  // make sure that the Europe/Berlin timezone and long datetime format is set
  // and to use the app locale to avoid test failures when running locally on
  // an OS with a regional setting other than en-US
  // XXX: doesn't work if your OS is in English but not US English.
  // Work around it by `export LC_TIME=en_US.UTF-8` before running the test.
  let dateformat = Services.prefs.getIntPref("calendar.date.format", 0);
  let tzlocal = Services.prefs.getStringPref("calendar.timezone.local", "Europe/Berlin");
  let useOsLocale = Services.prefs.getBoolPref("intl.regional_prefs.use_os_locales", false);
  Services.prefs.setBoolPref("intl.regional_prefs.use_os_locales", false);
  Services.prefs.setIntPref("calendar.date.format", 0);
  Services.prefs.setStringPref("calendar.timezone.local", "Europe/Berlin");
  for (let test of data) {
    let dom1 = getDom(test.input.previous);
    let dom2 = getDom(test.input.current);
    let result = ltn.invitation.compareInvitationOverlay(dom1, dom2);
    let dom = cal.xml.parseString(result);
    let id = test.expected.node;

    function assertChanges(name, nodes, expectedText) {
      equal(nodes.length, expectedText.length, `Equal number of ${name} for ${id}`);
      for (let text of expectedText) {
        let index;
        if (text instanceof RegExp) {
          index = nodes.findIndex(el => text.test(el.textContent));
        } else {
          index = nodes.findIndex(el => el.textContent === text);
        }
        ok(index !== -1, `${name} node with text ${text} for ${id}`);
        nodes.splice(index, 1);
      }
    }
    let node = dom.getElementById(id);
    ok(node, `Element with id ${id}`);
    assertChanges("<ins>", Array.from(node.querySelectorAll("ins.added")), test.expected.ins);
    assertChanges("<del>", Array.from(node.querySelectorAll("del.removed")), test.expected.del);
    assertChanges("modified", Array.from(node.querySelectorAll(".modified")), test.expected.mod);
  }
  // let's reset setting
  Services.prefs.setIntPref("calendar.date.format", dateformat);
  Services.prefs.setStringPref("calendar.timezone.local", tzlocal);
  Services.prefs.setBoolPref("intl.regional_prefs.use_os_locales", useOsLocale);
});

add_task(async function getHeaderSection_test() {
  let data = [
    {
      input: {
        toList: "recipient@example.net",
        subject: "Invitation: test subject",
        identity: {
          fullName: "Invitation sender",
          email: "sender@example.net",
          replyTo: "no-reply@example.net",
          organization: "Example Net",
          cc: "cc@example.net",
          bcc: "bcc@example.net",
        },
      },
      expected:
        "MIME-version: 1.0\r\n" +
        "Return-path: no-reply@example.net\r\n" +
        "From: Invitation sender <sender@example.net>\r\n" +
        "Organization: Example Net\r\n" +
        "To: recipient@example.net\r\n" +
        "Subject: Invitation: test subject\r\n" +
        "Cc: cc@example.net\r\n" +
        "Bcc: bcc@example.net\r\n",
    },
    {
      input: {
        toList: 'rec1@example.net, Recipient 2 <rec2@example.net>, "Rec, 3" <rec3@example.net>',
        subject: "Invitation: test subject",
        identity: {
          fullName: '"invitation, sender"',
          email: "sender@example.net",
          replyTo: "no-reply@example.net",
          organization: "Example Net",
          cc: 'cc1@example.net, Cc 2 <cc2@example.net>, "Cc, 3" <cc3@example.net>',
          bcc: 'bcc1@example.net, BCc 2 <bcc2@example.net>, "Bcc, 3" <bcc3@example.net>',
        },
      },
      expected:
        "MIME-version: 1.0\r\n" +
        "Return-path: no-reply@example.net\r\n" +
        'From: "invitation, sender" <sender@example.net>\r\n' +
        "Organization: Example Net\r\n" +
        'To: rec1@example.net, Recipient 2 <rec2@example.net>,\r\n "Rec, 3" <rec3@example.net>\r\n' +
        "Subject: Invitation: test subject\r\n" +
        'Cc: cc1@example.net, Cc 2 <cc2@example.net>, "Cc, 3" <cc3@example.net>\r\n' +
        'Bcc: bcc1@example.net, BCc 2 <bcc2@example.net>, "Bcc, 3"\r\n <bcc3@example.net>\r\n',
    },
    {
      input: {
        toList: "recipient@example.net",
        subject: "Invitation: test subject",
        identity: { email: "sender@example.net" },
      },
      expected:
        "MIME-version: 1.0\r\n" +
        "From: sender@example.net\r\n" +
        "To: recipient@example.net\r\n" +
        "Subject: Invitation: test subject\r\n",
    },
    {
      input: {
        toList: "Max Müller <mueller@example.net>",
        subject: "Invitation: Diacritis check (üäé)",
        identity: {
          fullName: "René",
          email: "sender@example.net",
          replyTo: "Max & René <no-reply@example.net>",
          organization: "Max & René",
          cc: "René <cc@example.net>",
          bcc: "René <bcc@example.net>",
        },
      },
      expected:
        "MIME-version: 1.0\r\n" +
        "Return-path: =?UTF-8?B?TWF4ICYgUmVuw6k=?= <no-reply@example.net>\r\n" +
        "From: =?UTF-8?B?UmVuw6k=?= <sender@example.net>\r\n" +
        "Organization: =?UTF-8?B?TWF4ICYgUmVuw6k=?=\r\n" +
        "To: =?UTF-8?Q?Max_M=c3=bcller?= <mueller@example.net>\r\n" +
        "Subject: =?UTF-8?B?SW52aXRhdGlvbjogRGlhY3JpdGlzIGNoZWNrICjDvMOk?=\r\n =?UTF-8?B" +
        "?w6kp?=\r\n" +
        "Cc: =?UTF-8?B?UmVuw6k=?= <cc@example.net>\r\n" +
        "Bcc: =?UTF-8?B?UmVuw6k=?= <bcc@example.net>\r\n",
    },
  ];
  let i = 0;
  for (let test of data) {
    i++;
    let identity = MailServices.accounts.createIdentity();
    identity.email = test.input.identity.email || null;
    identity.fullName = test.input.identity.fullName || null;
    identity.replyTo = test.input.identity.replyTo || null;
    identity.organization = test.input.identity.organization || null;
    identity.doCc = test.input.identity.doCc || test.input.identity.cc;
    identity.doCcList = test.input.identity.cc || null;
    identity.doBcc = test.input.identity.doBcc || test.input.identity.bcc;
    identity.doBccList = test.input.identity.bcc || null;

    let composeUtils = Cc["@mozilla.org/messengercompose/computils;1"].createInstance(
      Ci.nsIMsgCompUtils
    );
    let messageId = composeUtils.msgGenerateMessageId(identity);

    let header = ltn.invitation.getHeaderSection(
      messageId,
      identity,
      test.input.toList,
      test.input.subject
    );
    // we test Date and Message-ID headers separately to avoid false positives
    ok(!!header.match(/Date:.+(?:\n|\r\n|\r)/), "(test #" + i + "): date");
    ok(!!header.match(/Message-ID:.+(?:\n|\r\n|\r)/), "(test #" + i + "): message-id");
    equal(
      header.replace(/Date:.+(?:\n|\r\n|\r)/, "").replace(/Message-ID:.+(?:\n|\r\n|\r)/, ""),
      test.expected.replace(/Date:.+(?:\n|\r\n|\r)/, "").replace(/Message-ID:.+(?:\n|\r\n|\r)/, ""),
      "(test #" + i + "): all headers"
    );
  }
});

add_task(async function convertFromUnicode_test() {
  let data = [
    {
      input: {
        charset: "UTF-8",
        text: "müller",
      },
      expected: "mÃ¼ller",
    },
    {
      input: {
        charset: "UTF-8",
        text: "muller",
      },
      expected: "muller",
    },
    {
      input: {
        charset: "UTF-8",
        text: "müller\nmüller",
      },
      expected: "mÃ¼ller\nmÃ¼ller",
    },
    {
      input: {
        charset: "UTF-8",
        text: "müller\r\nmüller",
      },
      expected: "mÃ¼ller\r\nmÃ¼ller",
    },
  ];
  let i = 0;
  for (let test of data) {
    i++;
    equal(
      ltn.invitation.convertFromUnicode(test.input.charset, test.input.text),
      test.expected,
      "(test #" + i + ")"
    );
  }
});

add_task(async function encodeUTF8_test() {
  let data = [
    {
      input: "müller",
      expected: "mÃ¼ller",
    },
    {
      input: "muller",
      expected: "muller",
    },
    {
      input: "müller\nmüller",
      expected: "mÃ¼ller\r\nmÃ¼ller",
    },
    {
      input: "müller\r\nmüller",
      expected: "mÃ¼ller\r\nmÃ¼ller",
    },
    {
      input: "",
      expected: "",
    },
  ];
  let i = 0;
  for (let test of data) {
    i++;
    equal(ltn.invitation.encodeUTF8(test.input), test.expected, "(test #" + i + ")");
  }
});

add_task(async function encodeMimeHeader_test() {
  let data = [
    {
      input: {
        header: "Max Müller <m.mueller@example.net>",
        isEmail: true,
      },
      expected: "=?UTF-8?Q?Max_M=c3=bcller?= <m.mueller@example.net>",
    },
    {
      input: {
        header: "Max Mueller <m.mueller@example.net>",
        isEmail: true,
      },
      expected: "Max Mueller <m.mueller@example.net>",
    },
    {
      input: {
        header: "Müller & Müller",
        isEmail: false,
      },
      expected: "=?UTF-8?B?TcO8bGxlciAmIE3DvGxsZXI=?=",
    },
  ];

  let i = 0;
  for (let test of data) {
    i++;
    equal(
      ltn.invitation.encodeMimeHeader(test.input.header, test.input.isEmail),
      test.expected,
      "(test #" + i + ")"
    );
  }
});

add_task(async function getRfc5322FormattedDate_test() {
  let data = {
    input: [
      {
        date: null,
        timezone: "America/New_York",
      },
      {
        date: "Sat, 24 Jan 2015 09:24:49 +0100",
        timezone: "America/New_York",
      },
      {
        date: "Sat, 24 Jan 2015 09:24:49 GMT+0100",
        timezone: "America/New_York",
      },
      {
        date: "Sat, 24 Jan 2015 09:24:49 GMT",
        timezone: "America/New_York",
      },
      {
        date: "Sat, 24 Jan 2015 09:24:49",
        timezone: "America/New_York",
      },
      {
        date: "Sat, 24 Jan 2015 09:24:49",
        timezone: null,
      },
      {
        date: "Sat, 24 Jan 2015 09:24:49",
        timezone: "UTC",
      },
      {
        date: "Sat, 24 Jan 2015 09:24:49",
        timezone: "floating",
      },
    ],
    expected: /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/,
  };

  let i = 0;
  let timezone = Services.prefs.getStringPref("calendar.timezone.local", null);
  for (let test of data.input) {
    i++;
    if (test.timezone) {
      Services.prefs.setStringPref("calendar.timezone.local", test.timezone);
    } else {
      Services.prefs.clearUserPref("calendar.timezone.local");
    }
    let date = test.date ? new Date(test.date) : null;
    let re = new RegExp(data.expected);
    ok(re.test(ltn.invitation.getRfc5322FormattedDate(date)), "(test #" + i + ")");
  }
  Services.prefs.setStringPref("calendar.timezone.local", timezone);
});

add_task(async function parseCounter_test() {
  // We are disabling this rule for a more consistent display of this data
  /* eslint-disable object-curly-newline */
  let data = [
    {
      // #1: basic test to check all currently supported properties
      input: {
        existing: [],
        proposed: [
          {
            method: "METHOD:COUNTER",
          },
          {
            dtStart: "DTSTART;TZID=Europe/Berlin:20150910T210000",
          },
          {
            dtEnd: "DTEND;TZID=Europe/Berlin:20150910T220000",
          },
          {
            location: "LOCATION:Room 2",
          },
          {
            summary: "SUMMARY:Test Event 2",
          },
          {
            attendee:
              "ATTENDEE;CN=Attendee;PARTSTAT=DECLINED;ROLE=REQ-PARTICIPANT:" +
              "mailto:attendee@example.net",
          },
          {
            dtStamp: "DTSTAMP:20150909T182048Z",
          },
          {
            attach: "COMMENT:Sorry, I cannot make it that time.",
          },
        ],
      },
      expected: {
        // Time format is platform dependent, so we use alternative result sets here.
        // The first two are configurations running for automated tests.
        // If you get a failure for this test, add your pattern here.
        result: { descr: "", type: "OK" },
        differences: [
          {
            property: "SUMMARY",
            proposed: "Test Event 2",
            original: "Test Event",
          },
          {
            property: "LOCATION",
            proposed: "Room 2",
            original: "Room 1",
          },
          {
            property: "DTSTART",
            proposed: [
              "Thursday, September 10, 2015 9:00 PM Europe/Berlin",
              "Thursday, September 10, 2015 21:00 Europe/Berlin",
            ],
            original: [
              "Wednesday, September 09, 2015 9:00 PM Europe/Berlin", // Windows
              "Wednesday, September 09, 2015 21:00 Europe/Berlin",
              "Wednesday, September 9, 2015 9:00 PM Europe/Berlin", // Linux and Mac
              "Wednesday, September 9, 2015 21:00 Europe/Berlin",
            ],
          },
          {
            property: "DTEND",
            proposed: [
              "Thursday, September 10, 2015 10:00 PM Europe/Berlin",
              "Thursday, September 10, 2015 22:00 Europe/Berlin",
            ],
            original: [
              "Wednesday, September 09, 2015 10:00 PM Europe/Berlin", // Windows
              "Wednesday, September 09, 2015 22:00 Europe/Berlin",
              "Wednesday, September 9, 2015 10:00 PM Europe/Berlin", // Linux and Mac
              "Wednesday, September 9, 2015 22:00 Europe/Berlin",
            ],
          },
          {
            property: "COMMENT",
            proposed: "Sorry, I cannot make it that time.",
            original: null,
          },
        ],
      },
    },
    {
      // #2: test with an unsupported property has been changed
      input: {
        existing: [],
        proposed: [
          {
            method: "METHOD:COUNTER",
          },
          {
            attendee:
              "ATTENDEE;CN=Attendee;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:" +
              "mailto:attendee@example.net",
          },
          {
            location: "LOCATION:Room 2",
          },
          {
            attach: "ATTACH:http://www.example2.com",
          },
          {
            dtStamp: "DTSTAMP:20150909T182048Z",
          },
        ],
      },
      expected: {
        result: { descr: "", type: "OK" },
        differences: [{ property: "LOCATION", proposed: "Room 2", original: "Room 1" }],
      },
    },
    {
      // #3: proposed change not based on the latest update of the invitation
      input: {
        existing: [],
        proposed: [
          {
            method: "METHOD:COUNTER",
          },
          {
            attendee:
              "ATTENDEE;CN=Attendee;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:" +
              "mailto:attendee@example.net",
          },
          {
            location: "LOCATION:Room 2",
          },
          {
            dtStamp: "DTSTAMP:20150909T171048Z",
          },
        ],
      },
      expected: {
        result: {
          descr: "This is a counterproposal not based on the latest event update.",
          type: "NOTLATESTUPDATE",
        },
        differences: [{ property: "LOCATION", proposed: "Room 2", original: "Room 1" }],
      },
    },
    {
      // #4: proposed change based on a meanwhile reschuled invitation
      input: {
        existing: [],
        proposed: [
          {
            method: "METHOD:COUNTER",
          },
          {
            attendee:
              "ATTENDEE;CN=Attendee;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:" +
              "mailto:attendee@example.net",
          },
          {
            location: "LOCATION:Room 2",
          },
          {
            sequence: "SEQUENCE:0",
          },
          {
            dtStamp: "DTSTAMP:20150909T182048Z",
          },
        ],
      },
      expected: {
        result: {
          descr: "This is a counterproposal to an already rescheduled event.",
          type: "OUTDATED",
        },
        differences: [{ property: "LOCATION", proposed: "Room 2", original: "Room 1" }],
      },
    },
    {
      // #5: proposed change for an later sequence of the event
      input: {
        existing: [],
        proposed: [
          {
            method: "METHOD:COUNTER",
          },
          {
            attendee:
              "ATTENDEE;CN=Attendee;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:" +
              "mailto:attendee@example.net",
          },
          {
            location: "LOCATION:Room 2",
          },
          {
            sequence: "SEQUENCE:2",
          },
          {
            dtStamp: "DTSTAMP:20150909T182048Z",
          },
        ],
      },
      expected: {
        result: {
          descr: "Invalid sequence number in counterproposal.",
          type: "ERROR",
        },
        differences: [],
      },
    },
    {
      // #6: proposal to a different event
      input: {
        existing: [],
        proposed: [
          {
            method: "METHOD:COUNTER",
          },
          {
            uid: "UID:cb189fdc-0000-0000-0000-31a08802249d",
          },
          {
            attendee:
              "ATTENDEE;CN=Attendee;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:" +
              "mailto:attendee@example.net",
          },
          {
            location: "LOCATION:Room 2",
          },
          {
            dtStamp: "DTSTAMP:20150909T182048Z",
          },
        ],
      },
      expected: {
        result: {
          descr: "Mismatch of uid or organizer in counterproposal.",
          type: "ERROR",
        },
        differences: [],
      },
    },
    {
      // #7: proposal with a different organizer
      input: {
        existing: [],
        proposed: [
          {
            method: "METHOD:COUNTER",
          },
          {
            organizer:
              "ORGANIZER;RSVP=TRUE;CN=Organizer;PARTSTAT=ACCEPTED;ROLE=CHAI" +
              "R:mailto:organizer2@example.net",
          },
          {
            attendee:
              "ATTENDEE;CN=Attendee;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:" +
              "mailto:attendee@example.net",
          },
          {
            dtStamp: "DTSTAMP:20150909T182048Z",
          },
        ],
      },
      expected: {
        result: {
          descr: "Mismatch of uid or organizer in counterproposal.",
          type: "ERROR",
        },
        differences: [],
      },
    },
    {
      // #8:counterproposal without any difference
      input: {
        existing: [],
        proposed: [{ method: "METHOD:COUNTER" }],
      },
      expected: {
        result: {
          descr: "No difference in counterproposal detected.",
          type: "NODIFF",
        },
        differences: [],
      },
    },
  ];
  /* eslint-enable object-curly-newline */

  // make sure to use the app locale to avoid test failures when running
  // locally on an OS with a regional setting other than en-US
  let useOsLocale = Services.prefs.getBoolPref("intl.regional_prefs.use_os_locales", false);
  Services.prefs.setBoolPref("intl.regional_prefs.use_os_locales", false);

  let getItem = function(aProperties) {
    let item = getIcs(true);

    let modifyProperty = function(aRegex, aReplacement, aInVevent) {
      let inVevent = false;
      let i = 0;
      item.forEach(aProp => {
        if (aProp == "BEGIN:VEVENT" && !inVevent) {
          inVevent = true;
        } else if (aProp == "END:VEVENT" && inVevent) {
          inVevent = false;
        }
        if ((aInVevent && inVevent) || !aInVevent) {
          item[i] = aProp.replace(aRegex, aReplacement);
        }
        i++;
      });
    };

    if (aProperties) {
      aProperties.forEach(aProp => {
        if ("method" in aProp && aProp.method) {
          modifyProperty(/(METHOD.+)/, aProp.method, false);
        } else if ("attendee" in aProp && aProp.attendee) {
          modifyProperty(/(ATTENDEE.+)/, aProp.attendee, true);
        } else if ("attach" in aProp && aProp.attach) {
          modifyProperty(/(ATTACH.+)/, aProp.attach, true);
        } else if ("summary" in aProp && aProp.summary) {
          modifyProperty(/(SUMMARY.+)/, aProp.summary, true);
        } else if ("location" in aProp && aProp.location) {
          modifyProperty(/(LOCATION.+)/, aProp.location, true);
        } else if ("dtStart" in aProp && aProp.dtStart) {
          modifyProperty(/(DTSTART.+)/, aProp.dtStart, true);
        } else if ("dtEnd" in aProp && aProp.dtEnd) {
          modifyProperty(/(DTEND.+)/, aProp.dtEnd, true);
        } else if ("sequence" in aProp && aProp.sequence) {
          modifyProperty(/(SEQUENCE.+)/, aProp.sequence, true);
        } else if ("dtStamp" in aProp && aProp.dtStamp) {
          modifyProperty(/(DTSTAMP.+)/, aProp.dtStamp, true);
        } else if ("organizer" in aProp && aProp.organizer) {
          modifyProperty(/(ORGANIZER.+)/, aProp.organizer, true);
        } else if ("uid" in aProp && aProp.uid) {
          modifyProperty(/(UID.+)/, aProp.uid, true);
        }
      });
    }
    item = item.join("\r\n");
    return createEventFromIcalString(item);
  };

  let formatDt = function(aDateTime) {
    let datetime = cal.dtz.formatter.formatDateTime(aDateTime);
    return datetime + " " + aDateTime.timezone.displayName;
  };

  for (let i = 1; i <= data.length; i++) {
    let test = data[i - 1];
    let existingItem = getItem(test.input.existing);
    let proposedItem = getItem(test.input.proposed);
    let parsed = ltn.invitation.parseCounter(proposedItem, existingItem);

    equal(parsed.result.type, test.expected.result.type, "(test #" + i + ": result.type)");
    equal(parsed.result.descr, test.expected.result.descr, "(test #" + i + ": result.descr)");
    let parsedProps = [];
    let additionalProps = [];
    let missingProps = [];
    parsed.differences.forEach(aDiff => {
      let expected = test.expected.differences.filter(bDiff => bDiff.property == aDiff.property);
      if (expected.length == 1) {
        if (["DTSTART", "DTEND"].includes(aDiff.property)) {
          let prop = aDiff.proposed ? formatDt(aDiff.proposed) : null;
          ok(
            prop && expected[0].proposed.includes(prop),
            "(test #" + i + ": difference " + aDiff.property + ": proposed '" + prop + "')"
          );
          prop = aDiff.original ? formatDt(aDiff.original) : null;
          ok(
            prop && expected[0].original.includes(prop),
            "(test #" + i + ": difference " + aDiff.property + ": original '" + prop + "')"
          );
        } else {
          equal(
            aDiff.proposed,
            expected[0].proposed,
            "(test #" + i + ": difference " + aDiff.property + ": proposed)"
          );
          equal(
            aDiff.original,
            expected[0].original,
            "(test #" + i + ": difference " + aDiff.property + ": original)"
          );
        }
        parsedProps.push(aDiff.property);
      } else if (expected.length == 0) {
        additionalProps.push(aDiff.property);
      }
    });
    test.expected.differences.forEach(aDiff => {
      if (!parsedProps.includes(aDiff.property)) {
        missingProps.push(aDiff.property);
      }
    });
    ok(
      additionalProps.length == 0,
      "(test #" +
        i +
        ": differences: check for unexpectedly " +
        "occurring additional properties " +
        additionalProps +
        ")"
    );
    ok(
      missingProps.length == 0,
      "(test #" +
        i +
        ": differences: check for unexpectedly " +
        "missing properties " +
        missingProps +
        ")"
    );
  }

  Services.prefs.setBoolPref("intl.regional_prefs.use_os_locales", useOsLocale);
});
