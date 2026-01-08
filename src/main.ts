import { Plugin, WorkspaceLeaf, TFile, MarkdownView } from 'obsidian';
import { SupabaseProvider } from './provider';
import { AtomicSyncSettings, DEFAULT_SETTINGS, AtomicSyncSettingTab } from './settings';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as Y from 'yjs';
import { yCollab } from 'y-codemirror.next';
import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { IndexeddbPersistence } from 'y-indexeddb';

export default class AtomicSyncPlugin extends Plugin {
    settings: AtomicSyncSettings;
    supabase: SupabaseClient;
    collabCompartment = new Compartment();
    // Keep track of active connections
    providers = new WeakMap<EditorView, { provider: SupabaseProvider, persistence: IndexeddbPersistence }>();

    async onload() {
        console.log('Loading Atomic Sync plugin');

        await this.loadSettings();

        this.addSettingTab(new AtomicSyncSettingTab(this.app, this));

        // Initialize Supabase if settings exist
        if (this.settings.supabaseUrl && this.settings.supabaseKey) {
            this.initSupabase();
        }

        // Register the compartment
        this.registerEditorExtension(this.collabCompartment.of([]));

        // Listen for file opening
        this.registerEvent(
            this.app.workspace.on('file-open', this.handleFileOpen.bind(this))
        );
    }

    initSupabase() {
        if (!this.settings.supabaseUrl || !this.settings.supabaseKey) {
            console.log("Supabase credentials not configured yet");
            return;
        }
        try {
            this.supabase = createClient(this.settings.supabaseUrl, this.settings.supabaseKey);
            console.log("Supabase client initialized successfully");
        } catch (e) {
            console.error("Failed to init Supabase client", e);
        }
    }

    async handleFileOpen(file: TFile | null) {
        if (!file) return;

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;

        const editorView = (view.editor as any).cm as EditorView;
        if (!editorView) return;

        // Cleanup old
        const old = this.providers.get(editorView);
        if (old) {
            old.provider.destroy();
            old.persistence.destroy();
            this.providers.delete(editorView);
        }

        if (!this.supabase || !this.settings.vaultPassword) return;

        // Initialize Yjs
        const ydoc = new Y.Doc();
        const ytext = ydoc.getText('codemirror');

        // 1. Connect Persistence (Offline support)
        const persistence = new IndexeddbPersistence(file.path, ydoc);

        // 2. Connect Provider (Cloud support)
        const provider = new SupabaseProvider(ydoc, this.supabase, file.path, this.settings.vaultPassword);

        this.providers.set(editorView, { provider, persistence });

        editorView.dispatch({
            effects: this.collabCompartment.reconfigure(
                yCollab(ytext, provider.awareness)
            )
        });
    }

    onunload() {
        console.log('Unloading Atomic Sync plugin');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.initSupabase();
    }
}
