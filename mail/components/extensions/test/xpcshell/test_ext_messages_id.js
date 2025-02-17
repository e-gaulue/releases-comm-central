/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var { ExtensionTestUtils } = ChromeUtils.import(
  "resource://testing-common/ExtensionXPCShellUtils.jsm"
);

add_task(
  {
    skip_if: () => IS_NNTP,
  },
  async function setup() {
    let account = createAccount();
    let rootFolder = account.incomingServer.rootFolder;
    let subFolders = {
      test1: await createSubfolder(rootFolder, "test1"),
      test2: await createSubfolder(rootFolder, "test2"),
      test3: await createSubfolder(rootFolder, "test3"),
    };
    await createMessages(subFolders.test1, 5);
  }
);

add_task(
  {
    skip_if: () => IS_NNTP,
  },
  async function test_identifiers() {
    let extension = ExtensionTestUtils.loadExtension({
      files: {
        "background.js": async () => {
          // In this test we'll move and copy some messages around between
          // folders. Every operation should result in the message's id property
          // changing to a never-seen-before value.

          let [{ folders }] = await browser.accounts.list();
          let testFolder1 = folders.find(f => f.name == "test1");
          let testFolder2 = folders.find(f => f.name == "test2");
          let testFolder3 = folders.find(f => f.name == "test3");

          let { messages } = await browser.messages.list(testFolder1);
          browser.test.assertEq(
            5,
            messages.length,
            "message count in testFolder1"
          );
          browser.test.assertEq(1, messages[0].id);
          browser.test.assertEq(2, messages[1].id);
          browser.test.assertEq(3, messages[2].id);
          browser.test.assertEq(4, messages[3].id);
          browser.test.assertEq(5, messages[4].id);

          let subjects = messages.map(m => m.subject);

          // Move two messages. We could do this in one operation, but to be
          // sure of the order, do it in separate operations.

          await browser.messages.move([1], testFolder2);
          await browser.messages.move([3], testFolder2);

          ({ messages } = await browser.messages.list(testFolder1));
          browser.test.assertEq(
            3,
            messages.length,
            "message count in testFolder1"
          );
          browser.test.assertEq(2, messages[0].id);
          browser.test.assertEq(4, messages[1].id);
          browser.test.assertEq(5, messages[2].id);
          browser.test.assertEq(subjects[1], messages[0].subject);
          browser.test.assertEq(subjects[3], messages[1].subject);
          browser.test.assertEq(subjects[4], messages[2].subject);

          ({ messages } = await browser.messages.list(testFolder2));
          browser.test.assertEq(
            2,
            messages.length,
            "message count in testFolder2"
          );
          browser.test.assertEq(6, messages[0].id, "new id created");
          browser.test.assertEq(7, messages[1].id, "new id created");
          browser.test.assertEq(subjects[0], messages[0].subject);
          browser.test.assertEq(subjects[2], messages[1].subject);

          // Copy one message.

          await browser.messages.copy([6], testFolder3);

          ({ messages } = await browser.messages.list(testFolder2));
          browser.test.assertEq(
            2,
            messages.length,
            "message count in testFolder2"
          );
          browser.test.assertEq(6, messages[0].id);
          browser.test.assertEq(7, messages[1].id);
          browser.test.assertEq(subjects[0], messages[0].subject);
          browser.test.assertEq(subjects[2], messages[1].subject);

          ({ messages } = await browser.messages.list(testFolder3));
          browser.test.assertEq(
            1,
            messages.length,
            "message count in testFolder3"
          );
          browser.test.assertEq(8, messages[0].id, "new id created");
          browser.test.assertEq(subjects[0], messages[0].subject);

          // Move the copied message back to the previous folder. There should
          // now be two copies there, each with their own ID.

          await browser.messages.move([8], testFolder2);

          ({ messages } = await browser.messages.list(testFolder2));
          browser.test.assertEq(
            3,
            messages.length,
            "message count in testFolder2"
          );
          browser.test.assertEq(6, messages[0].id);
          browser.test.assertEq(7, messages[1].id);
          browser.test.assertEq(
            9,
            messages[2].id,
            "new id created, not a duplicate"
          );
          browser.test.assertEq(subjects[0], messages[0].subject);
          browser.test.assertEq(subjects[2], messages[1].subject);
          browser.test.assertEq(
            subjects[0],
            messages[2].subject,
            "same message as another in this folder"
          );

          browser.test.notifyPass("finished");
        },
        "utils.js": await getUtilsJS(),
      },
      manifest: {
        background: { scripts: ["utils.js", "background.js"] },
        permissions: ["accountsRead", "messagesMove", "messagesRead"],
      },
    });

    await extension.startup();
    await extension.awaitFinish("finished");
    await extension.unload();
  }
);
