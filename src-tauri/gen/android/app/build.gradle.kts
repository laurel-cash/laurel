import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release credentials are supplied by the operator, never kept in this project.
val releaseKeys = listOf("LAUREL_ANDROID_KEYSTORE", "LAUREL_ANDROID_STORE_PASSWORD", "LAUREL_ANDROID_KEY_ALIAS", "LAUREL_ANDROID_KEY_PASSWORD")
val releaseValues = releaseKeys.map { System.getenv(it)?.takeIf { value -> value.isNotBlank() } }
require(releaseValues.all { it == null } || releaseValues.all { it != null }) {
    "Set all four LAUREL_ANDROID signing variables, or leave them all unset for an unsigned build."
}

android {
    compileSdk = 36
    // the NDK scripts/android.ps1 builds with: Gradle strips the engine's library
    // with it, and keeps the symbols it took out for Play (debugSymbolLevel)
    ndkVersion = "29.0.14206865"
    namespace = "com.rptxsoftware.wallet"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.rptxsoftware.wallet"
        minSdk = 28
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        // a crash in the engine reads as function names in Play's reports, not addresses:
        // the bundle carries the library's symbol table, and phones get it stripped
        ndk.debugSymbolLevel = "SYMBOL_TABLE"
    }
    signingConfigs {
        if (releaseValues.all { it != null }) {
            create("release") {
                storeFile = file(releaseValues[0]!!)
                require(storeFile!!.isFile) { "The configured release keystore does not exist." }
                storePassword = releaseValues[1]
                keyAlias = releaseValues[2]
                keyPassword = releaseValues[3]
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
        }
        getByName("release") {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

// a debug build keeps the engine's symbols in the APK, for a debugger on the emulator.
// Per variant: Tauri's packaging {} inside getByName("debug") is android-wide, and kept
// them in the release too, so the bundle had no symbol table and phones got 36 MB
androidComponents {
    onVariants(selector().withBuildType("debug")) { variant ->
        variant.packaging.jniLibs.keepDebugSymbols.add("**/*.so")
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
