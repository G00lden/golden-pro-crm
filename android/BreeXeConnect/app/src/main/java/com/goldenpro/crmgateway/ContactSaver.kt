package com.goldenpro.crmgateway

// Idempotent device contact writer. BreeXe-owned contacts are updated in place;
// personal contacts with the same number are never renamed or overwritten.

import android.Manifest
import android.content.ContentProviderOperation
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract
import androidx.core.content.ContextCompat

object ContactSaver {
    private const val SOURCE_PREFIX = "breexe:"
    private const val SYNC_MARKER = "breexe"

    fun saveCaller(
        context: Context,
        phone: String,
        displayName: String = "",
        customerId: String = "",
    ): Boolean {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CONTACTS) != PackageManager.PERMISSION_GRANTED
        ) return false

        val normalized = GatewayRepository.normalizePhone(phone).filter(Char::isDigit)
        if (normalized.length < 8) return false
        val resolvedName = displayName.trim().ifBlank { CallerContactPolicy.displayName(normalized) }
        val sourceId = SOURCE_PREFIX + customerId.trim().ifBlank { normalized }

        return runCatching {
            val ownedRawId = findOwnedRawContact(context, sourceId, normalized)
            if (ownedRawId != null) {
                updateOwnedContact(context, ownedRawId, resolvedName, normalized)
                return@runCatching true
            }

            val existingContactId = findContactId(context, normalized)
            if (existingContactId != null) {
                // Contacts created by BreeXe 2.1.x did not carry a source marker.
                // Adopt only the generated placeholder, never a personal name.
                val placeholderRawId = findPlaceholderRawContact(context, existingContactId)
                if (placeholderRawId != null) {
                    markOwned(context, placeholderRawId, sourceId)
                    updateOwnedContact(context, placeholderRawId, resolvedName, normalized)
                }
                return@runCatching true
            }

            val operations = arrayListOf<ContentProviderOperation>()
            operations += ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
                .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null)
                .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null)
                .withValue(ContactsContract.RawContacts.SOURCE_ID, sourceId)
                .withValue(ContactsContract.RawContacts.SYNC1, SYNC_MARKER)
                .build()
            operations += ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
                .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, resolvedName)
                .build()
            operations += ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
                .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, "+$normalized")
                .withValue(ContactsContract.CommonDataKinds.Phone.TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE)
                .build()
            context.contentResolver.applyBatch(ContactsContract.AUTHORITY, operations)
            true
        }.getOrElse {
            GatewayPreferences.markError(context, it.message ?: "تعذر حفظ رقم المتصل في جهات الاتصال.")
            false
        }
    }

    private fun findOwnedRawContact(context: Context, sourceId: String, normalizedPhone: String): Long? {
        context.contentResolver.query(
            ContactsContract.RawContacts.CONTENT_URI,
            arrayOf(ContactsContract.RawContacts._ID),
            "${ContactsContract.RawContacts.SOURCE_ID}=? AND ${ContactsContract.RawContacts.SYNC1}=?",
            arrayOf(sourceId, SYNC_MARKER),
            null,
        )?.use { cursor -> if (cursor.moveToFirst()) return cursor.getLong(0) }

        // A contact may have been created with the number before the CRM id was
        // known. Match only BreeXe-owned raw contacts and let the caller adopt it.
        val contactId = findContactId(context, normalizedPhone) ?: return null
        return context.contentResolver.query(
            ContactsContract.RawContacts.CONTENT_URI,
            arrayOf(ContactsContract.RawContacts._ID),
            "${ContactsContract.RawContacts.CONTACT_ID}=? AND ${ContactsContract.RawContacts.SYNC1}=?",
            arrayOf(contactId.toString(), SYNC_MARKER),
            null,
        )?.use { cursor -> if (cursor.moveToFirst()) cursor.getLong(0) else null }
    }

    private fun findContactId(context: Context, normalizedPhone: String): Long? {
        val uri = Uri.withAppendedPath(
            ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
            Uri.encode(normalizedPhone),
        )
        return context.contentResolver.query(
            uri,
            arrayOf(ContactsContract.PhoneLookup._ID),
            null,
            null,
            null,
        )?.use { cursor -> if (cursor.moveToFirst()) cursor.getLong(0) else null }
    }

    private fun findPlaceholderRawContact(context: Context, contactId: Long): Long? {
        val rawIds = context.contentResolver.query(
            ContactsContract.RawContacts.CONTENT_URI,
            arrayOf(ContactsContract.RawContacts._ID),
            "${ContactsContract.RawContacts.CONTACT_ID}=?",
            arrayOf(contactId.toString()),
            null,
        )?.use { cursor ->
            buildList { while (cursor.moveToNext()) add(cursor.getLong(0)) }
        }.orEmpty()
        for (rawId in rawIds) {
            val generated = context.contentResolver.query(
                ContactsContract.Data.CONTENT_URI,
                arrayOf(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME),
                "${ContactsContract.Data.RAW_CONTACT_ID}=? AND ${ContactsContract.Data.MIMETYPE}=?",
                arrayOf(rawId.toString(), ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE),
                null,
            )?.use { cursor -> cursor.moveToFirst() && cursor.getString(0).orEmpty().startsWith("متصل CRM ") } == true
            if (generated) return rawId
        }
        return null
    }

    private fun markOwned(context: Context, rawId: Long, sourceId: String) {
        val values = ContentValues().apply {
            put(ContactsContract.RawContacts.SOURCE_ID, sourceId)
            put(ContactsContract.RawContacts.SYNC1, SYNC_MARKER)
        }
        context.contentResolver.update(
            ContactsContract.RawContacts.CONTENT_URI,
            values,
            "${ContactsContract.RawContacts._ID}=?",
            arrayOf(rawId.toString()),
        )
    }

    private fun updateOwnedContact(context: Context, rawId: Long, name: String, normalizedPhone: String) {
        val nameValues = ContentValues().apply {
            put(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, name)
        }
        val updatedName = context.contentResolver.update(
            ContactsContract.Data.CONTENT_URI,
            nameValues,
            "${ContactsContract.Data.RAW_CONTACT_ID}=? AND ${ContactsContract.Data.MIMETYPE}=?",
            arrayOf(rawId.toString(), ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE),
        )
        if (updatedName == 0) {
            nameValues.put(ContactsContract.Data.RAW_CONTACT_ID, rawId)
            nameValues.put(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
            context.contentResolver.insert(ContactsContract.Data.CONTENT_URI, nameValues)
        }

        val phoneValues = ContentValues().apply {
            put(ContactsContract.CommonDataKinds.Phone.NUMBER, "+$normalizedPhone")
            put(ContactsContract.CommonDataKinds.Phone.TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE)
        }
        val updatedPhone = context.contentResolver.update(
            ContactsContract.Data.CONTENT_URI,
            phoneValues,
            "${ContactsContract.Data.RAW_CONTACT_ID}=? AND ${ContactsContract.Data.MIMETYPE}=?",
            arrayOf(rawId.toString(), ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE),
        )
        if (updatedPhone == 0) {
            phoneValues.put(ContactsContract.Data.RAW_CONTACT_ID, rawId)
            phoneValues.put(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
            context.contentResolver.insert(ContactsContract.Data.CONTENT_URI, phoneValues)
        }
    }
}
