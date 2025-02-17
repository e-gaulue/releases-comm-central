/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const EXPORTED_SYMBOLS = ["LDAPModuleLoader"];

var { ComponentUtils } = ChromeUtils.import(
  "resource://gre/modules/ComponentUtils.jsm"
);
var { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

/**
 * Determine whether to use nsLDAPService.cpp or LDAPService.jsm. When
 * `mailnews.ldap.jsmodule` is `true`, use LDAPService.jsm.
 */
function LDAPModuleLoader() {
  try {
    this.loadModule();
  } catch (e) {
    Cu.reportError(e);
  }
}

var ldapJSModules = [
  // moduleName, interfaceId, contractId
  [
    "LDAPDirectory",
    "{8683e821-f1b0-476d-ac15-07771c79bb11}",
    "@mozilla.org/addressbook/directory;1?type=moz-abldapdirectory",
  ],
  [
    "LDAPReplicationService",
    "{dbe204e8-ae09-11eb-b4c8-a7e4b3e6e82e}",
    "@mozilla.org/addressbook/ldap-replication-service;1",
  ],
];

LDAPModuleLoader.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),

  observe() {
    // Nothing to do here, just need the entry so this is instantiated.
  },

  loadModule() {
    if (Services.prefs.getBoolPref("mailnews.ldap.jsmodule", false)) {
      let registrar = Components.manager.QueryInterface(
        Ci.nsIComponentRegistrar
      );

      for (let [moduleName, interfaceId, contractId] of ldapJSModules) {
        // Load a module.
        let scope = ChromeUtils.import(`resource:///modules/${moduleName}.jsm`);
        scope.NSGetFactory = ComponentUtils.generateNSGetFactory([
          scope[moduleName],
        ]);

        // Register a module.
        let classId = Components.ID(interfaceId);
        registrar.registerFactory(
          classId,
          "",
          contractId,
          lazyFactoryFor(scope, classId)
        );
      }

      dump("[LDAPModuleLoader] Using LDAPDirectory.jsm\n");
    } else {
      dump("[LDAPModuleLoader] Using nsAbLDAPDirectory.cpp\n");
    }
  },
};

function lazyFactoryFor(backendScope, classID) {
  return {
    createInstance(aOuter, aIID) {
      let realFactory = backendScope.NSGetFactory(classID);
      return realFactory.createInstance(aOuter, aIID);
    },
    lockFactory(lock) {
      let realFactory = backendScope.NSGetFactory(classID);
      return realFactory.lockFactory(lock);
    },
  };
}
