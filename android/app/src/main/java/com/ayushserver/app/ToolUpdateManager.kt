package com.ayushserver.app

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

class ToolUpdateManager(private val context: Context) {

    data class UpdateInfo(
        val isUpdateAvailable: Boolean,
        val latestVersion: String,
        val downloadUrl: String?,
        val releaseNotes: String
    )

    suspend fun checkForUpdates(): UpdateInfo = withContext(Dispatchers.IO) {
        try {
            val url = URL("https://api.github.com/repos/ayushyadav7172/ayushserver/releases/latest")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                setRequestProperty("User-Agent", "AyushServer-Android")
                connectTimeout = 5000
                readTimeout = 5000
            }

            if (conn.responseCode == 200) {
                val response = conn.inputStream.bufferedReader().use(BufferedReader::readText)
                val json = JSONObject(response)
                val tag = json.optString("tag_name", "v1.0.0")
                val notes = json.optString("body", "")
                val assets = json.optJSONArray("assets")
                var apkUrl: String? = null

                if (assets != null) {
                    for (i in 0 until assets.length()) {
                        val asset = assets.getJSONObject(i)
                        val name = asset.optString("name", "")
                        if (name.endsWith(".apk", ignoreCase = true)) {
                            apkUrl = asset.optString("browser_download_url")
                            break
                        }
                    }
                }

                val currentVersion = try {
                    context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "1.0.2"
                } catch (e: Exception) {
                    "1.0.2"
                }
                val cleanRemoteVer = tag.replace("^v", "").replace(Regex("[-_].*$"), "")
                val isAvailable = cleanRemoteVer != currentVersion && apkUrl != null

                UpdateInfo(isAvailable, tag, apkUrl, notes)
            } else {
                UpdateInfo(false, "v1.0.2", null, "No newer release found")
            }
        } catch (e: Exception) {
            UpdateInfo(false, "v1.0.2", null, "Check error: ${e.message}")
        }
    }

    fun downloadAndInstallApk(apkUrl: String, fileName: String = "AyushServer-Update.apk") {
        val destination = File(
            context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
            fileName
        )
        if (destination.exists()) {
            destination.delete()
        }

        val request = DownloadManager.Request(Uri.parse(apkUrl)).apply {
            setTitle("AyushServer Updating Tools & App")
            setDescription("Downloading latest build...")
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            setDestinationUri(Uri.fromFile(destination))
        }

        val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val downloadId = manager.enqueue(request)

        val onComplete = object : BroadcastReceiver() {
            override fun onReceive(ctxt: Context, intent: Intent) {
                val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)
                if (id == downloadId) {
                    try {
                        context.unregisterReceiver(this)
                    } catch (_: Exception) {}
                    installApk(destination)
                }
            }
        }

        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(onComplete, filter, Context.RECEIVER_EXPORTED)
        } else {
            context.registerReceiver(onComplete, filter)
        }
    }

    private fun installApk(file: File) {
        val apkUri: Uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file
        )
        val installIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(apkUri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(installIntent)
    }
}
