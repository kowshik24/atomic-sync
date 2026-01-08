export async function deriveKey(password: string): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );

    return window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: enc.encode("atomic-sync-salt"), // In production, this should be random and stored per-file or per-vault
            iterations: 100000,
            hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        true, // exportable
        ["encrypt", "decrypt"]
    );
}

export async function encrypt(data: Uint8Array, key: CryptoKey): Promise<{ iv: Uint8Array, content: Uint8Array }> {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await window.crypto.subtle.encrypt(
        {
            name: "AES-GCM",
            iv: iv,
        },
        key,
        data
    );

    return {
        iv: iv,
        content: new Uint8Array(encrypted)
    };
}

export async function decrypt(encryptedData: Uint8Array, iv: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
    const decrypted = await window.crypto.subtle.decrypt(
        {
            name: "AES-GCM",
            iv: iv,
        },
        key,
        encryptedData
    );

    return new Uint8Array(decrypted);
}
