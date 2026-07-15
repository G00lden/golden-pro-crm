plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.legacy.kapt)
}

fun String.asBuildConfigString(): String =
    "\"" + replace("\\", "\\\\").replace("\"", "\\\"") + "\""

val defaultGatewayUrl = providers.environmentVariable("GATEWAY_URL")
    .orElse("")
val firebaseProjectId = providers.environmentVariable("FIREBASE_PROJECT_ID").orElse("")
val firebaseApplicationId = providers.environmentVariable("FIREBASE_APPLICATION_ID").orElse("")
val firebaseApiKey = providers.environmentVariable("FIREBASE_API_KEY").orElse("")
android {
    namespace = "com.goldenpro.crmgateway"
    buildToolsVersion = "37.0.0"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }

    defaultConfig {
        applicationId = "com.goldenpro.crmgateway"
        minSdk = 24
        targetSdk = 36
        versionCode = 8
        versionName = "2.1.2"

        buildConfigField("String", "DEFAULT_GATEWAY_URL", defaultGatewayUrl.get().asBuildConfigString())
        buildConfigField("String", "FIREBASE_PROJECT_ID", firebaseProjectId.get().asBuildConfigString())
        buildConfigField("String", "FIREBASE_APPLICATION_ID", firebaseApplicationId.get().asBuildConfigString())
        buildConfigField("String", "FIREBASE_API_KEY", firebaseApiKey.get().asBuildConfigString())

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            optimization {
                enable = false
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures {
        buildConfig = true
        compose = true
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(files("libs/material3.aar"))
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.work.runtime)
    implementation(libs.google.code.scanner)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    implementation(libs.androidx.sqlite)
    implementation(files("libs/sqlcipher-android-4.15.0.aar"))
    implementation(libs.firebase.messaging)
    kapt(libs.androidx.room.compiler)
    testImplementation(libs.junit)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
