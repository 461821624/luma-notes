/**
 * Luma App Main Entry
 */

class LumaApp {
  constructor() {
    this.initialize();
  }

  initialize() {
    // Use common module for interactive checkboxes
    if (window.LumaCommon) {
      LumaCommon.setupInteractiveCheckboxes();
    }
  }
}

LumaCommon.onDOMReady(() => {
  new LumaApp();
});

window.LumaApp = LumaApp;
