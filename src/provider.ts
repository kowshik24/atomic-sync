import * as Y from 'yjs';
import { SupabaseClient } from '@supabase/supabase-js';
import { Awareness } from 'y-protocols/awareness';
import { encrypt, decrypt, deriveKey } from './encryption';

export class SupabaseProvider {
    doc: Y.Doc;
    supabase: SupabaseClient;
    path: string;
    awareness: Awareness;
    channel: any;
    encryptionKey: CryptoKey | null = null;
    isLoaded: boolean = false;

    constructor(doc: Y.Doc, supabase: SupabaseClient, path: string, password?: string) {
        this.doc = doc;
        this.supabase = supabase;
        this.path = path;
        this.awareness = new Awareness(doc);

        if (password) {
            this.initEncryption(password).then(() => {
                this.connect();
            });
        } else {
            console.warn("No password provided, encryption disabled (NOT RECOMMENDED)");
            this.connect();
        }
    }

    async initEncryption(password: string) {
        this.encryptionKey = await deriveKey(password);
    }

    async connect() {
        console.log(`Connecting to Supabase for ${this.path}`);
        await this.sync();
        this.subscribe();

        // Listen for local updates and push them
        this.doc.on('update', this.handleUpdate.bind(this));
    }

    async sync() {
        // 1. Get Document ID
        const { data: docData, error: docError } = await this.supabase
            .from('documents')
            .select('id')
            .eq('path', this.path)
            .maybeSingle();

        if (docError) {
            console.error('Error fetching document:', docError);
            return;
        }

        let docId = docData?.id;

        // If not exists, create it
        if (!docId) {
            const { data: newDoc, error: createError } = await this.supabase
                .from('documents')
                .insert({ path: this.path })
                .select('id')
                .single();

            if (createError) {
                console.error('Error creating document:', createError);
                return;
            }
            docId = newDoc.id;
        }

        // 2. Fetch Updates
        const { data: updates, error: updatesError } = await this.supabase
            .from('updates')
            .select('update_blob')
            .eq('document_id', docId)
            .order('created_at', { ascending: true });

        if (updatesError) {
            console.error('Error fetching updates:', updatesError);
            return;
        }

        // 3. Apply Updates
        if (updates && updates.length > 0) {
            this.doc.transact(async () => { // Transact to batch updates
                for (const row of updates) {
                    // Convert hex string to Uint8Array if necessary (Supabase returns bytea as hex string or buffer depending on client?)
                    // The JS client usually returns a string for bytea (hex format) or standard buffer.
                    // For now assuming we need to handle the data format.
                    // Let's check typical Supabase return. It often returns a hex string for `bytea`.

                    let blob = row.update_blob;
                    if (typeof blob === 'string') {
                        if (blob.startsWith('\\x')) blob = blob.substring(2);
                        // Convert hex to Uint8Array
                        const match = blob.match(/.{1,2}/g);
                        if (match) {
                            blob = new Uint8Array(match.map((byte: string) => parseInt(byte, 16)));
                        }
                    }

                    if (this.encryptionKey) {
                        // We need the IV. Where did we store it?
                        // Ah, the design said: "update_blob" is the encrypted binary data. 
                        // We need to pack the IV with the data or store it separately.
                        // Common practice: Prepend IV to the cyphertext.
                        // Let's assume the blob is [IV (12 bytes) + DEST (rest)]
                        const iv = blob.slice(0, 12);
                        const ciphertext = blob.slice(12);
                        try {
                            const decrypted = await decrypt(ciphertext, iv, this.encryptionKey);
                            Y.applyUpdate(this.doc, decrypted);
                        } catch (e) {
                            console.error("Decryption failed for an update:", e);
                        }
                    } else {
                        Y.applyUpdate(this.doc, new Uint8Array(blob));
                    }
                }
            }, 'remote'); // Origin 'remote' to avoid echoing back
        }

        this.isLoaded = true;
    }

    async handleUpdate(update: Uint8Array, origin: any) {
        if (origin === 'remote') return; // Don't push back what we just pulled

        // 1. Encrypt
        let blobToSend: Uint8Array;
        if (this.encryptionKey) {
            try {
                const { iv, content } = await encrypt(update, this.encryptionKey);
                // Concatenate IV + Content
                blobToSend = new Uint8Array(iv.length + content.length);
                blobToSend.set(iv);
                blobToSend.set(content, iv.length);
            } catch (e) {
                console.error("Encryption failed:", e);
                console.error("Update size:", update.length);
                console.error("Key exists:", !!this.encryptionKey);
                return; // Don't send if encryption fails
            }
        } else {
            blobToSend = update;
        }

        // 2. Push to Supabase
        try {
            // We need the docId. Ideally we cache it.
            const { data: docData, error } = await this.supabase.from('documents').select('id').eq('path', this.path).single();
            if (error || !docData) {
                console.error("Failed to get document ID:", error);
                return;
            }

            // Convert Uint8Array to Hex string for postgres bytea
            const hexBlob = '0x' + Array.from(blobToSend).map(b => b.toString(16).padStart(2, '0')).join('');

            const { error: insertError } = await this.supabase.from('updates').insert({
                document_id: docData.id,
                update_blob: hexBlob
            });

            if (insertError) {
                console.error("Failed to insert update:", insertError);
            } else {
                console.log("✅ Update saved to Supabase");
            }
        } catch (e) {
            console.error("Error in handleUpdate:", e);
        }
    }

    subscribe() {
        this.channel = this.supabase
            .channel(`doc:${this.path}`)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'updates',
                // filter: `document_id=eq.${docId}` // Hard to get docId here cleanly without waiting. 
                // We can filter by verifying the document path via a join, but Realtime doesn't do joins.
                // Instead, we will fetch the new row, check if it belongs to our doc (we can cache docId).
            }, async (payload) => {
                // We need to check if this update belongs to OUR document.
                // The payload contains the new row.
                // But the row only has `document_id`.

                // Optimization: Store docId in class property.
                if (!this.docIdCached) {
                    const { data } = await this.supabase.from('documents').select('id').eq('path', this.path).single();
                    this.docIdCached = data?.id;
                }

                if (payload.new.document_id !== this.docIdCached) return;

                // It's for us!
                let blob = payload.new.update_blob;
                // Convert from hex string
                if (typeof blob === 'string') {
                    if (blob.startsWith('\\x')) blob = blob.substring(2); // Postgres output format sometimes
                    else if (blob.startsWith('0x')) blob = blob.substring(2);

                    const match = blob.match(/.{1,2}/g);
                    if (match) {
                        blob = new Uint8Array(match.map((byte: string) => parseInt(byte, 16)));
                    }
                }

                // Decrypt and Apply
                if (this.encryptionKey) {
                    const iv = blob.slice(0, 12);
                    const ciphertext = blob.slice(12);
                    try {
                        const decrypted = await decrypt(ciphertext, iv, this.encryptionKey);
                        Y.applyUpdate(this.doc, decrypted, 'remote');
                    } catch (e) { console.error(e) }
                }

            })
            .subscribe();
    }

    docIdCached: string | null = null;

    destroy() {
        if (this.channel) this.supabase.removeChannel(this.channel);
        this.awareness.destroy();
        this.doc.destroy();
    }
}
