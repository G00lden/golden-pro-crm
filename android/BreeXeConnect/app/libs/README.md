# Vendored Android libraries

These AAR files are committed so the Android build remains reproducible on the
Windows build host, where large Maven downloads can intermittently fail with
TLS `bad_record_mac` errors.

- `sqlcipher-android-4.15.0.aar`
  - Source: Maven Central, `net.zetetic:sqlcipher-android:4.15.0`
  - SHA-256: `480C9176AECBC8A3A7BD98441372BBA5AD9482F57E54C5734B9A7E97A39971D8`
- `material3.aar`
  - Compose Material 3 build used by BreeXe Connect
  - SHA-256: `3A37E8B36DF3822FE1E6059F0F9FAFDA8800388860477624AC1B9422C418A36E`

Do not replace either binary without recording its upstream coordinate and
verified checksum here.
