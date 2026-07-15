package com.goldenpro.crmgateway

// Android Keystore-backed device credential storage.

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Keeps the per-device CRM credential encrypted by a non-exportable Android Keystore key. */
object GatewaySecretStore {
    private const val PREFS = "crm_gateway_secrets"
    private const val CIPHERTEXT = "gateway_token_ciphertext"
    private const val IV = "gateway_token_iv"
    private const val KEY_ALIAS = "golden_pro_crm_gateway_token_v1"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"

    fun read(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val encodedCiphertext = prefs.getString(CIPHERTEXT, "").orEmpty()
        val encodedIv = prefs.getString(IV, "").orEmpty()
        if (encodedCiphertext.isBlank() || encodedIv.isBlank()) return ""

        return runCatching {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                GCMParameterSpec(128, Base64.decode(encodedIv, Base64.NO_WRAP)),
            )
            String(
                cipher.doFinal(Base64.decode(encodedCiphertext, Base64.NO_WRAP)),
                Charsets.UTF_8,
            )
        }.getOrDefault("")
    }

    fun write(context: Context, token: String): Boolean {
        if (token.isBlank()) {
            clear(context)
            return true
        }
        return runCatching {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit(commit = true) {
                putString(CIPHERTEXT, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                putString(IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            }
            true
        }.getOrDefault(false)
    }

    private fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit {
            remove(CIPHERTEXT)
            remove(IV)
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
            generateKey()
        }
    }
}
