// Mock implementation of Obsidian API for testing
export class Plugin {
  app: any;
  manifest: any;

  constructor(app: any, manifest: any) {
    this.app = app;
    this.manifest = manifest;
  }

  async onload() {}
  async onunload() {}
  async loadData() {
    return {};
  }
  async saveData(data: any) {}
  addCommand(command: any) {}
  addSettingTab(tab: any) {}
}

export class Notice {
  constructor(message: string) {
    console.log(`Notice: ${message}`);
  }
}

export class PluginSettingTab {
  app: any;
  plugin: any;

  constructor(app: any, plugin: any) {
    this.app = app;
    this.plugin = plugin;
  }

  display() {}
  hide() {}
}

export class Setting {
  setName(name: string) {
    return this;
  }
  setDesc(desc: string) {
    return this;
  }
  addText(cb: any) {
    return this;
  }
  addDropdown(cb: any) {
    return this;
  }
  addSlider(cb: any) {
    return this;
  }
  addButton(cb: any) {
    return this;
  }
}

export const mockApp = {
  vault: {
    getMarkdownFiles: () => [],
    read: async (file: any) => '',
    modify: async (file: any, content: string) => {},
    adapter: {
      write: async (path: string, content: string) => {},
    },
  },
};
