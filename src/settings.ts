import { App, PluginSettingTab, Setting } from 'obsidian';
import AtomicSyncPlugin from './main';

export interface AtomicSyncSettings {
    supabaseUrl: string;
    supabaseKey: string;
    vaultPassword: string;
}

export const DEFAULT_SETTINGS: AtomicSyncSettings = {
    supabaseUrl: '',
    supabaseKey: '',
    vaultPassword: ''
}

export class AtomicSyncSettingTab extends PluginSettingTab {
    plugin: AtomicSyncPlugin;

    constructor(app: App, plugin: AtomicSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        new Setting(containerEl)
            .setName('Supabase URL')
            .setDesc('Your Supabase Project URL')
            .addText(text => text
                .setPlaceholder('https://xyz.supabase.co')
                .setValue(this.plugin.settings.supabaseUrl)
                .onChange(async (value) => {
                    this.plugin.settings.supabaseUrl = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Supabase Key')
            .setDesc('Your Supabase Anon Key')
            .addText(text => text
                .setPlaceholder('eyJh...')
                .setValue(this.plugin.settings.supabaseKey)
                .onChange(async (value) => {
                    this.plugin.settings.supabaseKey = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Vault Password')
            .setDesc('Used to derive the encryption key. DO NOT LOSE THIS.')
            .addText(text => text
                .setPlaceholder('MySecretPassword')
                .setValue(this.plugin.settings.vaultPassword)
                .onChange(async (value) => {
                    this.plugin.settings.vaultPassword = value;
                    await this.plugin.saveSettings();
                }));
    }
}
