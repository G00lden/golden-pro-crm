package com.goldenpro.crmgateway

import android.app.Application
import android.util.Log

/**
 * Process entry point. SQLCipher must be loaded before Room creates its first
 * connection; the dashboard reads the encrypted queue during activity startup.
 */
class BreeXeApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Loading a native library must never make the whole application
        // disappear. Database callers receive a controlled Kotlin exception
        // and the dashboard can show recovery guidance instead of crash-looping.
        SqlCipherRuntime.load()
    }
}

object SqlCipherRuntime {
    private const val TAG = "BreeXeSqlCipher"

    @Volatile
    private var loaded = false

    @Volatile
    private var failure: Throwable? = null

    @Synchronized
    fun load(): Boolean {
        if (loaded) return true
        return runCatching {
            System.loadLibrary("sqlcipher")
            loaded = true
            failure = null
            Log.i(TAG, "SQLCipher native runtime loaded")
            true
        }.getOrElse { error ->
            failure = error
            Log.e(TAG, "Unable to load SQLCipher native runtime", error)
            false
        }
    }

    fun requireLoaded() {
        if (!load()) {
            throw IllegalStateException(
                "SQLCipher runtime is unavailable: ${failure?.javaClass?.simpleName ?: "unknown"}",
                failure,
            )
        }
    }
}
