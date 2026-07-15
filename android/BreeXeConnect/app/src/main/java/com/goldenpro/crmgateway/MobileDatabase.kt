package com.goldenpro.crmgateway

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@Entity(tableName = "mobile_events", primaryKeys = ["id"])
data class MobileEventEntity(
    val id: String,
    val payload: String,
    val source: String,
    val createdAt: Long,
)

@Entity(tableName = "caller_cache", primaryKeys = ["phone"])
data class CallerCacheEntity(
    val phone: String,
    val name: String,
    val company: String,
    val ownerName: String,
    val lastDeal: String,
    val overdue: Boolean,
    val updatedAt: Long,
)

@Entity(tableName = "mobile_commands", primaryKeys = ["id"])
data class MobileCommandEntity(
    val id: String,
    val type: String,
    val payload: String,
    val status: String,
    val expiresAt: String,
    val createdAt: String,
)

@Dao
interface MobileDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun addEvent(event: MobileEventEntity): Long

    @Query("SELECT * FROM mobile_events ORDER BY createdAt ASC LIMIT :limit")
    fun events(limit: Int): List<MobileEventEntity>

    @Query("DELETE FROM mobile_events WHERE id IN (:ids)")
    fun removeEvents(ids: List<String>)

    @Query("SELECT COUNT(*) FROM mobile_events")
    fun eventCount(): Int

    @Query("SELECT COUNT(*) FROM mobile_events WHERE source = 'android_test' OR id LIKE 'android-test-%'")
    fun testEventCount(): Int

    @Query("DELETE FROM mobile_events WHERE source = 'android_test' OR id LIKE 'android-test-%'")
    fun clearTestEvents(): Int

    @Query("SELECT id FROM mobile_events ORDER BY createdAt ASC LIMIT :count")
    fun oldestEventIds(count: Int): List<String>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun saveCallers(items: List<CallerCacheEntity>)

    @Query("DELETE FROM caller_cache")
    fun clearCallers()

    @Query("SELECT * FROM caller_cache WHERE phone = :phone LIMIT 1")
    fun caller(phone: String): CallerCacheEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun saveCommands(items: List<MobileCommandEntity>)

    @Query("SELECT * FROM mobile_commands WHERE status IN ('pending','delivered') ORDER BY createdAt ASC")
    fun pendingCommands(): List<MobileCommandEntity>

    @Query("SELECT * FROM mobile_commands WHERE id = :id LIMIT 1")
    fun command(id: String): MobileCommandEntity?

    @Query("UPDATE mobile_commands SET status = :status WHERE id = :id")
    fun updateCommand(id: String, status: String)

    @Query("DELETE FROM mobile_commands WHERE status NOT IN ('pending','delivered') OR expiresAt < :now")
    fun pruneCommands(now: String)

    @Query("DELETE FROM mobile_events")
    fun clearEvents()

    @Query("DELETE FROM caller_cache")
    fun wipeCallerCache()

    @Query("DELETE FROM mobile_commands")
    fun clearCommands()
}

@Database(
    entities = [MobileEventEntity::class, CallerCacheEntity::class, MobileCommandEntity::class],
    version = 1,
    exportSchema = false,
)
abstract class MobileDatabase : RoomDatabase() {
    abstract fun mobileDao(): MobileDao

    companion object {
        @Volatile private var instance: MobileDatabase? = null

        fun get(context: Context): MobileDatabase = instance ?: synchronized(this) {
            SqlCipherRuntime.requireLoaded()
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                MobileDatabase::class.java,
                "breexe_mobile.db",
            )
                .openHelperFactory(SupportOpenHelperFactory(DatabasePassphrase.getOrCreate(context)))
                .allowMainThreadQueries()
                .build()
                .also { instance = it }
        }

        fun wipe(context: Context) {
            instance?.close()
            instance = null
            context.deleteDatabase("breexe_mobile.db")
        }
    }
}

private object DatabasePassphrase {
    private const val PREFS = "breexe_database_secret"
    private const val CIPHERTEXT = "ciphertext"
    private const val IV = "iv"
    private const val KEY_ALIAS = "breexe_mobile_database_v1"

    fun getOrCreate(context: Context): ByteArray {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val ciphertext = prefs.getString(CIPHERTEXT, "").orEmpty()
        val iv = prefs.getString(IV, "").orEmpty()
        if (ciphertext.isNotBlank() && iv.isNotBlank()) {
            runCatching {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
                return cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP))
            }
        }
        val passphrase = ByteArray(32).also(SecureRandom()::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.doFinal(passphrase)
        prefs.edit(commit = true) {
            putString(CIPHERTEXT, Base64.encodeToString(encrypted, Base64.NO_WRAP))
            putString(IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
        }
        return passphrase
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
            generateKey()
        }
    }
}
