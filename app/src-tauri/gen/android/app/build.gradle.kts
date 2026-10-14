import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

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

// Release signing: the keystore stays outside the repo (C:/Users/User/.android-keys). keystore.properties (git-ignored,
// next to this project's settings.gradle) names it:
//   storeFile=C:/Users/User/.android-keys/my-assistant.jks
//   keyAlias=my-assistant
//   passwordFile=C:/Users/User/.android-keys/my-assistant.password.txt
// The password comes from passwordFile, or the MYASSISTANT_KEY_PASSWORD environment variable if that file is removed.
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
val signingPassword: String? = System.getenv("MYASSISTANT_KEY_PASSWORD")
    ?: keystoreProperties.getProperty("passwordFile")?.let { f -> file(f).takeIf { it.exists() }?.readText()?.trim() }

android {
    compileSdk = 37
    namespace = "com.chris.chrismanager"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.chris.chrismanager"
        minSdk = 24
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        create("release") {
            if (keystoreProperties.getProperty("storeFile") != null && signingPassword != null) {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = signingPassword
                keyAlias = keystoreProperties.getProperty("keyAlias", "my-assistant")
                keyPassword = signingPassword
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (signingPassword == null || keystoreProperties.getProperty("storeFile") == null) {
                throw GradleException("Release builds need the signing key: keystore.properties and the key password (see the top of this file).")
            }
            signingConfig = signingConfigs.getByName("release")
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
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

apply(from = file("tauri.build.gradle.kts"))
