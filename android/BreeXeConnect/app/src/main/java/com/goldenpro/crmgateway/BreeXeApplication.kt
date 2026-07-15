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
        SqlCipherRuntime.load()
    }
}

object SqlCipherRuntime {
    private const val TAG = "BreeXeSqlCipher"

    @Volatile
    private var loaded = false

    @Synchronized
    fun load() {
        if (loaded) return
        System.loadLibrary("sqlcipher")
        loaded = true
        Log.i(TAG, "SQLCipher native runtime loaded")
    }

    fun requireLoaded() {
        if (!loaded) load()
    }
}
