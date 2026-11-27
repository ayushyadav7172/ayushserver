package com.ayushserver.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.webkit.*
import android.widget.*
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.google.android.material.bottomsheet.BottomSheetDialog
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.*

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var swipeRefreshLayout: SwipeRefreshLayout
    private lateinit var progressBar: ProgressBar
    private lateinit var menuFab: TextView

    private val prefs by lazy { getSharedPreferences("ayush_server_settings", Context.MODE_PRIVATE) }

    private var serverUrl: String
        get() = prefs.getString("custom_server_url", "http://127.0.0.1:3000") ?: "http://127.0.0.1:3000"
        set(value) {
            val cleaned = sanitizeUrl(value)
            prefs.edit().putString("custom_server_url", cleaned).apply()
        }

    private var isDesktopMode: Boolean
        get() = prefs.getBoolean("is_desktop_mode", false)
        set(value) {
            prefs.edit().putBoolean("is_desktop_mode", value).apply()
            applyDesktopMode(value)
        }

    private var pageZoom: Int
        get() = prefs.getInt("page_zoom", 100)
        set(value) {
            val clamped = value.coerceIn(50, 200)
            prefs.edit().putInt("page_zoom", clamped).apply()
            applyZoom(clamped)
        }

    private var downloadFolder: String
        get() = prefs.getString("download_folder", "AyushServer") ?: "AyushServer"
        set(value) {
            val cleaned = value.trim().ifEmpty { "AyushServer" }
            prefs.edit().putString("download_folder", cleaned).apply()
        }

    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        var uris: Array<Uri>? = null
        if (result.resultCode == RESULT_OK && result.data != null) {
            val clipData = result.data?.clipData
            val dataUri = result.data?.data
            if (clipData != null && clipData.itemCount > 0) {
                uris = Array(clipData.itemCount) { i -> clipData.getItemAt(i).uri }
            } else if (dataUri != null) {
                uris = arrayOf(dataUri)
            } else {
                uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            }
        }
        filePathCallback?.onReceiveValue(uris)
        filePathCallback = null
    }

    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        checkStoragePermission()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Start Foreground Service to keep CPU active for encoding tasks
        val serviceIntent = Intent(this, ServerForegroundService::class.java).apply {
            action = ServerForegroundService.ACTION_START
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }

        setupViews()
        setupWebView()
        setupBackNavigation()
        requestAppPermissions()

        loadServer()
    }

    private fun sanitizeUrl(input: String): String {
        var url = input.trim()
        if (url.isEmpty()) return "http://127.0.0.1:3000"
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://$url"
        }
        return url.trimEnd('/')
    }

    private fun setupViews() {
        val rootLayout = FrameLayout(this)

        swipeRefreshLayout = SwipeRefreshLayout(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            setColorSchemeColors(ContextCompat.getColor(context, android.R.color.holo_blue_bright))
            setOnRefreshListener {
                webView.reload()
            }
        }

        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }
        swipeRefreshLayout.addView(webView)

        progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                8
            )
            max = 100
            visibility = View.GONE
        }

        // Floating ☰ Hamburger Menu button (Bottom Right corner)
        val menuBg = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.parseColor("#E6181A20"))
            setStroke(2, Color.parseColor("#38BDF8"))
        }

        menuFab = TextView(this).apply {
            text = "☰"
            textSize = 22f
            setTextColor(Color.parseColor("#38BDF8"))
            setTypeface(null, Typeface.BOLD)
            gravity = Gravity.CENTER
            background = menuBg
            alpha = 0.92f
            contentDescription = "Menu and Settings"
            val size = (48 * resources.displayMetrics.density).toInt()
            val margin = (16 * resources.displayMetrics.density).toInt()
            layoutParams = FrameLayout.LayoutParams(size, size).apply {
                gravity = Gravity.BOTTOM or Gravity.END
                setMargins(margin, margin, margin, margin + (32 * resources.displayMetrics.density).toInt())
            }
            setOnClickListener {
                showHamburgerMenu()
            }
        }

        rootLayout.addView(swipeRefreshLayout)
        rootLayout.addView(progressBar)
        rootLayout.addView(menuFab)
        setContentView(rootLayout)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        // Zoom controls
        settings.setSupportZoom(true)
        settings.builtInZoomControls = true
        settings.displayZoomControls = false
        applyZoom(pageZoom)
        applyDesktopMode(isDesktopMode)

        // Enable Cookies
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        webView.addJavascriptInterface(WebAppInterface(), "AyushAndroid")

        // Handle File Downloads
        webView.setDownloadListener { url, userAgent, contentDisposition, mimetype, contentLength ->
            handleDownload(url, userAgent, contentDisposition, mimetype, contentLength)
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                swipeRefreshLayout.isRefreshing = false
                progressBar.visibility = View.GONE
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true) {
                    swipeRefreshLayout.isRefreshing = false
                    progressBar.visibility = View.GONE
                    showOfflinePage()
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (newProgress < 100) {
                    progressBar.visibility = View.VISIBLE
                    progressBar.progress = newProgress
                } else {
                    progressBar.visibility = View.GONE
                }
            }

            override fun onShowFileChooser(
                mWebView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                this@MainActivity.filePathCallback?.onReceiveValue(null)
                this@MainActivity.filePathCallback = filePathCallback

                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)

                    val rawTypes = fileChooserParams?.acceptTypes?.filter { it.isNotBlank() } ?: emptyList()
                    val isImagePicker = rawTypes.any {
                        it.contains("image", true) || it.endsWith(".jpg", true) ||
                        it.endsWith(".jpeg", true) || it.endsWith(".png", true) ||
                        it.endsWith(".webp", true) || it.endsWith(".avif", true) ||
                        it.endsWith(".tif", true) || it.endsWith(".tiff", true)
                    }
                    val isVideoPicker = rawTypes.any {
                        it.contains("video", true) || it.endsWith(".mp4", true) ||
                        it.endsWith(".mkv", true) || it.endsWith(".avi", true) ||
                        it.endsWith(".mov", true) || it.endsWith(".webm", true)
                    }
                    val isPdfPicker = rawTypes.any {
                        it.contains("pdf", true) || it.endsWith(".pdf", true)
                    }

                    when {
                        isImagePicker -> type = "image/*"
                        isVideoPicker -> type = "video/*"
                        isPdfPicker -> type = "application/pdf"
                        else -> type = "*/*"
                    }

                    if (fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                }

                try {
                    fileChooserLauncher.launch(intent)
                } catch (e: Exception) {
                    this@MainActivity.filePathCallback?.onReceiveValue(null)
                    this@MainActivity.filePathCallback = null
                    return false
                }
                return true
            }
        }
    }

    private fun applyDesktopMode(enabled: Boolean) {
        val settings = webView.settings
        if (enabled) {
            settings.userAgentString = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
        } else {
            settings.userAgentString = null
            settings.useWideViewPort = false
            settings.loadWithOverviewMode = false
        }
    }

    private fun applyZoom(zoomPercent: Int) {
        webView.settings.textZoom = zoomPercent
    }

    private fun handleDownload(
        url: String,
        userAgent: String?,
        contentDisposition: String?,
        mimetype: String?,
        contentLength: Long
    ) {
        try {
            val fileName = URLUtil.guessFileName(url, contentDisposition, mimetype)
            val subFolder = downloadFolder

            val targetDir = File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                subFolder
            )
            if (!targetDir.exists()) targetDir.mkdirs()

            val request = DownloadManager.Request(Uri.parse(url)).apply {
                if (!mimetype.isNullOrBlank()) setMimeType(mimetype)
                val cookies = CookieManager.getInstance().getCookie(url)
                if (!cookies.isNullOrBlank()) addRequestHeader("cookie", cookies)
                if (!userAgent.isNullOrBlank()) addRequestHeader("User-Agent", userAgent)
                setDescription("Downloading from AyushServer...")
                setTitle(fileName)
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "$subFolder/$fileName")
            }

            val manager = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            manager.enqueue(request)

            saveDownloadRecord(fileName, "$subFolder/$fileName", mimetype ?: "*/*", contentLength)
            Toast.makeText(this, "Downloading: $fileName", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Download failed: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun saveDownloadRecord(name: String, relPath: String, mime: String, size: Long) {
        try {
            val list = getDownloadRecords()
            val obj = JSONObject().apply {
                put("name", name)
                put("path", relPath)
                put("mime", mime)
                put("size", size)
                put("time", System.currentTimeMillis())
            }
            list.put(0, obj)
            prefs.edit().putString("download_records", list.toString()).apply()
        } catch (_: Exception) {}
    }

    private fun getDownloadRecords(): JSONArray {
        val str = prefs.getString("download_records", "[]") ?: "[]"
        return try { JSONArray(str) } catch (_: Exception) { JSONArray() }
    }

    // ==================== ☰ HAMBURGER BOTTOM SHEET MENU ====================
    private fun showHamburgerMenu() {
        val dialog = BottomSheetDialog(this)
        val density = resources.displayMetrics.density

        val scrollView = ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#181A20"))
        }

        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (20 * density).toInt()
            setPadding(pad, pad, pad, (32 * density).toInt())
        }
        scrollView.addView(container)

        // Header
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, 0, 0, (14 * density).toInt())
        }
        val title = TextView(this).apply {
            text = "AyushServer App Menu"
            textSize = 18f
            setTextColor(Color.parseColor("#38BDF8"))
            setTypeface(null, Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val closeBtn = TextView(this).apply {
            text = "✕"
            textSize = 18f
            setTextColor(Color.parseColor("#94A3B8"))
            setPadding((12 * density).toInt(), 0, (12 * density).toInt(), 0)
            setOnClickListener { dialog.dismiss() }
        }
        header.addView(title)
        header.addView(closeBtn)
        container.addView(header)

        // Divider
        container.addView(createDivider())

        // 1. Desktop Site Toggle
        val desktopRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, (14 * density).toInt(), 0, (14 * density).toInt())
        }
        val desktopLabel = TextView(this).apply {
            text = "🖥️  Desktop Site Mode"
            textSize = 15f
            setTextColor(Color.WHITE)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val desktopSwitch = Switch(this).apply {
            isChecked = isDesktopMode
            setOnCheckedChangeListener { _, isChecked ->
                isDesktopMode = isChecked
                dialog.dismiss()
                webView.reload()
            }
        }
        desktopRow.addView(desktopLabel)
        desktopRow.addView(desktopSwitch)
        container.addView(desktopRow)

        container.addView(createDivider())

        // 2. Page Zoom Controls
        val zoomSection = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, (14 * density).toInt(), 0, (14 * density).toInt())
        }
        val zoomHeader = TextView(this).apply {
            text = "🔍  Page Scaling / Zoom ($pageZoom%)"
            textSize = 14f
            setTextColor(Color.parseColor("#E2E8F0"))
            setTypeface(null, Typeface.BOLD)
        }
        val zoomButtonsRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, (8 * density).toInt(), 0, 0)
        }

        val btnMinus = createMenuButton("➖ Zoom Out") {
            pageZoom = (pageZoom - 10).coerceAtLeast(50)
            zoomHeader.text = "🔍  Page Scaling / Zoom ($pageZoom%)"
        }
        val btnResetZoom = createMenuButton("100%") {
            pageZoom = 100
            zoomHeader.text = "🔍  Page Scaling / Zoom (100%)"
        }
        val btnPlus = createMenuButton("➕ Zoom In") {
            pageZoom = (pageZoom + 10).coerceAtMost(200)
            zoomHeader.text = "🔍  Page Scaling / Zoom ($pageZoom%)"
        }

        zoomButtonsRow.addView(btnMinus)
        zoomButtonsRow.addView(btnResetZoom)
        zoomButtonsRow.addView(btnPlus)
        zoomSection.addView(zoomHeader)
        zoomSection.addView(zoomButtonsRow)
        container.addView(zoomSection)

        container.addView(createDivider())

        // 3. Downloads Manager
        val records = getDownloadRecords()
        val downloadsRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, (14 * density).toInt(), 0, (14 * density).toInt())
            isClickable = true
            setOnClickListener {
                dialog.dismiss()
                showDownloadsDialog()
            }
        }
        val downloadsLabel = TextView(this).apply {
            text = "📥  Downloads Center (${records.length()})"
            textSize = 15f
            setTextColor(Color.WHITE)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val downloadsArrow = TextView(this).apply {
            text = "View ❯"
            textSize = 13f
            setTextColor(Color.parseColor("#38BDF8"))
        }
        downloadsRow.addView(downloadsLabel)
        downloadsRow.addView(downloadsArrow)
        container.addView(downloadsRow)

        container.addView(createDivider())

        // 4. Download Location Setting
        val locSection = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, (14 * density).toInt(), 0, (14 * density).toInt())
        }
        val locTitle = TextView(this).apply {
            text = "📁  Download Location"
            textSize = 14f
            setTextColor(Color.parseColor("#E2E8F0"))
            setTypeface(null, Typeface.BOLD)
        }
        val locDesc = TextView(this).apply {
            text = "Downloads/$downloadFolder"
            textSize = 12f
            setTextColor(Color.parseColor("#94A3B8"))
            setPadding(0, (2 * density).toInt(), 0, (8 * density).toInt())
        }
        val btnChangeLoc = createMenuButton("Change Download Folder") {
            dialog.dismiss()
            showChangeLocationDialog()
        }
        locSection.addView(locTitle)
        locSection.addView(locDesc)
        locSection.addView(btnChangeLoc)
        container.addView(locSection)

        container.addView(createDivider())

        // 5. Server IP Switcher & Refresh
        val serverSection = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, (14 * density).toInt(), 0, (14 * density).toInt())
        }
        val serverTitle = TextView(this).apply {
            text = "🌐  Server Connection"
            textSize = 14f
            setTextColor(Color.parseColor("#E2E8F0"))
            setTypeface(null, Typeface.BOLD)
        }
        val serverDesc = TextView(this).apply {
            text = serverUrl
            textSize = 12f
            setTextColor(Color.parseColor("#38BDF8"))
            setPadding(0, (2 * density).toInt(), 0, (8 * density).toInt())
        }
        val serverRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val btnChangeIp = createMenuButton("Change Server IP") {
            dialog.dismiss()
            showServerUrlDialog()
        }
        val btnReload = createMenuButton("🔄 Reload Page") {
            dialog.dismiss()
            webView.reload()
        }
        serverRow.addView(btnChangeIp)
        serverRow.addView(btnReload)
        serverSection.addView(serverTitle)
        serverSection.addView(serverDesc)
        serverSection.addView(serverRow)
        container.addView(serverSection)

        dialog.setContentView(scrollView)
        dialog.show()
    }

    private fun showDownloadsDialog() {
        val records = getDownloadRecords()
        if (records.length() == 0) {
            AlertDialog.Builder(this)
                .setTitle("📥 Downloads")
                .setMessage("No files downloaded yet.\nWhen you download converted videos, images, or PDFs, they will appear here.")
                .setPositiveButton("OK", null)
                .show()
            return
        }

        val density = resources.displayMetrics.density
        val scrollView = ScrollView(this)
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (16 * density).toInt()
            setPadding(pad, pad, pad, pad)
        }
        scrollView.addView(container)

        val sdf = SimpleDateFormat("MMM dd, HH:mm", Locale.getDefault())

        for (i in 0 until records.length()) {
            val item = records.optJSONObject(i) ?: continue
            val name = item.optString("name", "File")
            val relPath = item.optString("path", "")
            val time = item.optLong("time", 0L)

            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                val bg = GradientDrawable().apply {
                    setColor(Color.parseColor("#1F232B"))
                    cornerRadius = 10 * density
                }
                background = bg
                val p = (12 * density).toInt()
                setPadding(p, p, p, p)
                val m = (6 * density).toInt()
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { setMargins(0, 0, 0, m) }
            }

            val titleView = TextView(this).apply {
                text = name
                textSize = 14f
                setTextColor(Color.WHITE)
                setTypeface(null, Typeface.BOLD)
            }
            val metaView = TextView(this).apply {
                val dateStr = if (time > 0) sdf.format(Date(time)) else ""
                text = "Downloads/$relPath • $dateStr"
                textSize = 11f
                setTextColor(Color.parseColor("#94A3B8"))
                setPadding(0, 4, 0, 8)
            }

            val actionsRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
            }

            val btnOpen = createMenuButton("Open File") {
                openDownloadedFile(relPath)
            }
            val btnShare = createMenuButton("Share") {
                shareDownloadedFile(relPath)
            }
            actionsRow.addView(btnOpen)
            actionsRow.addView(btnShare)

            card.addView(titleView)
            card.addView(metaView)
            card.addView(actionsRow)
            container.addView(card)
        }

        AlertDialog.Builder(this)
            .setTitle("📥 Downloaded Files (${records.length()})")
            .setView(scrollView)
            .setPositiveButton("Close", null)
            .setNeutralButton("Clear List") { _, _ ->
                prefs.edit().remove("download_records").apply()
                Toast.makeText(this, "Downloads list cleared", Toast.LENGTH_SHORT).show()
            }
            .show()
    }

    private fun openDownloadedFile(relPath: String) {
        val file = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), relPath)
        if (!file.exists()) {
            Toast.makeText(this, "File not found: ${file.name}", Toast.LENGTH_SHORT).show()
            return
        }
        try {
            val uri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, getMimeTypeFromFile(file))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
        } catch (e: Exception) {
            Toast.makeText(this, "Cannot open file: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    private fun shareDownloadedFile(relPath: String) {
        val file = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), relPath)
        if (!file.exists()) {
            Toast.makeText(this, "File not found", Toast.LENGTH_SHORT).show()
            return
        }
        try {
            val uri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", file)
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = getMimeTypeFromFile(file)
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(intent, "Share ${file.name}"))
        } catch (e: Exception) {
            Toast.makeText(this, "Share error: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    private fun getMimeTypeFromFile(file: File): String {
        val ext = file.extension.lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "*/*"
    }

    private fun showChangeLocationDialog() {
        val editText = EditText(this).apply {
            setText(downloadFolder)
            hint = "Folder name inside Downloads"
            setPadding(32, 24, 32, 24)
            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
        }

        AlertDialog.Builder(this)
            .setTitle("📁 Download Folder Location")
            .setMessage("All files downloaded from AyushServer will be saved inside your phone's Downloads directory:\n\n/sdcard/Download/[Folder Name]")
            .setView(editText)
            .setPositiveButton("Save") { _, _ ->
                val newFolder = editText.text.toString().trim()
                if (newFolder.isNotEmpty()) {
                    downloadFolder = newFolder
                    Toast.makeText(this, "Download path set: Download/$downloadFolder", Toast.LENGTH_SHORT).show()
                }
            }
            .setNeutralButton("Reset Default") { _, _ ->
                downloadFolder = "AyushServer"
                Toast.makeText(this, "Reset to: Download/AyushServer", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    fun showServerUrlDialog() {
        val editText = EditText(this).apply {
            setText(serverUrl)
            hint = "http://192.168.1.15:3000"
            setSelection(text.length)
            setPadding(32, 24, 32, 24)
            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
        }

        AlertDialog.Builder(this)
            .setTitle("AyushServer Connection")
            .setMessage("Enter the IP and port of the device running AyushServer:\n(e.g., 192.168.1.15:3000 or 127.0.0.1:3000)")
            .setView(editText)
            .setPositiveButton("Connect") { _, _ ->
                val newUrl = editText.text.toString().trim()
                if (newUrl.isNotEmpty()) {
                    serverUrl = newUrl
                    loadServer()
                }
            }
            .setNeutralButton("Reset Localhost") { _, _ ->
                serverUrl = "http://127.0.0.1:3000"
                loadServer()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun createDivider(): View {
        return View(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                1
            )
            setBackgroundColor(Color.parseColor("#2D3139"))
        }
    }

    private fun createMenuButton(label: String, onClick: () -> Unit): Button {
        val density = resources.displayMetrics.density
        return Button(this).apply {
            text = label
            textSize = 12f
            setTextColor(Color.parseColor("#38BDF8"))
            val bg = GradientDrawable().apply {
                setColor(Color.parseColor("#252A34"))
                cornerRadius = 6 * density
            }
            background = bg
            val p = (8 * density).toInt()
            setPadding(p, 0, p, 0)
            val m = (4 * density).toInt()
            layoutParams = LinearLayout.LayoutParams(
                0,
                (36 * density).toInt(),
                1f
            ).apply { setMargins(m, 0, m, 0) }
            setOnClickListener { onClick() }
        }
    }

    inner class WebAppInterface {
        @JavascriptInterface
        fun updateServerUrl(newUrl: String) {
            runOnUiThread {
                serverUrl = newUrl
                loadServer()
            }
        }

        @JavascriptInterface
        fun openServerSettings() {
            runOnUiThread {
                showServerUrlDialog()
            }
        }

        @JavascriptInterface
        fun openHamburgerMenu() {
            runOnUiThread {
                showHamburgerMenu()
            }
        }
    }

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    private fun loadServer() {
        swipeRefreshLayout.isRefreshing = true
        webView.loadUrl(serverUrl)
    }

    private fun showOfflinePage() {
        val current = serverUrl
        val html = """
            <!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Server Offline</title>
              <style>
                * { box-sizing: border-box; }
                body { background: #0f1115; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; text-align: center; }
                .card { background: #181a20; border: 1px solid #2d3139; border-radius: 20px; padding: 28px 20px; max-width: 400px; width: 100%; box-shadow: 0 12px 30px rgba(0,0,0,0.6); }
                .icon { font-size: 48px; margin-bottom: 12px; }
                h2 { margin: 0 0 8px; font-size: 20px; color: #38bdf8; font-weight: 700; }
                p { color: #94a3b8; font-size: 13px; line-height: 1.5; margin: 0 0 16px; }
                .target-box { background: #090a0d; color: #38bdf8; padding: 10px 14px; border-radius: 10px; font-family: monospace; font-size: 13px; margin-bottom: 16px; border: 1px solid rgba(56,189,248,0.25); word-break: break-all; }
                .btn { background: #38bdf8; color: #000; font-weight: 700; border: none; padding: 12px 18px; border-radius: 10px; font-size: 14px; cursor: pointer; width: 100%; transition: opacity 0.2s; }
                .btn:active { opacity: 0.8; }
                .ip-section { margin-top: 20px; padding-top: 16px; border-top: 1px solid #2d3139; text-align: left; }
                .ip-label { font-size: 12px; font-weight: 600; color: #e2e8f0; margin-bottom: 6px; }
                .input-row { display: flex; gap: 8px; margin-bottom: 8px; }
                input[type=text] { flex: 1; background: #090a0d; border: 1px solid #38bdf866; color: #fff; padding: 10px 12px; border-radius: 8px; font-size: 13px; font-family: monospace; }
                input[type=text]:focus { outline: none; border-color: #38bdf8; }
                .btn-save { background: #22c55e; color: #000; font-weight: 700; border: none; padding: 10px 14px; border-radius: 8px; font-size: 13px; cursor: pointer; }
                .btn-ghost { background: transparent; color: #94a3b8; border: 1px solid #2d3139; padding: 8px 12px; border-radius: 8px; font-size: 12px; cursor: pointer; width: 100%; margin-top: 6px; }
                .status { font-size: 11px; color: #64748b; margin-top: 14px; display: flex; align-items: center; justify-content: center; }
                .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #eab308; margin-right: 6px; animation: pulse 1.5s infinite; }
                @keyframes pulse { 0% { opacity: 0.4; } 50% { opacity: 1; } 100% { opacity: 0.4; } }
              </style>
            </head>
            <body>
              <div class="card">
                <div class="icon">⚡</div>
                <h2>Server Not Responding</h2>
                <p>Cannot reach AyushServer at:</p>
                <div class="target-box" id="currentTarget">$current</div>
                <button class="btn" onclick="retry()">🔄 Retry Connection</button>

                <div class="ip-section">
                  <div class="ip-label">🌐 Connect to Another Device / Custom IP:</div>
                  <div class="input-row">
                    <input type="text" id="customInput" placeholder="192.168.1.15:3000" value="$current" />
                    <button class="btn-save" onclick="applyIp()">Connect</button>
                  </div>
                  <button class="btn-ghost" onclick="resetLocal()">Reset Localhost (127.0.0.1:3000)</button>
                </div>

                <div class="status"><span class="dot"></span><span id="st">Auto-detecting server...</span></div>
              </div>
              <script>
                function retry() {
                  document.getElementById('st').textContent = 'Reconnecting...';
                  window.location.href = '$current';
                }
                function applyIp() {
                  const val = document.getElementById('customInput').value.trim();
                  if (!val) return;
                  if (window.AyushAndroid && window.AyushAndroid.updateServerUrl) {
                    window.AyushAndroid.updateServerUrl(val);
                  } else {
                    window.location.href = val.startsWith('http') ? val : 'http://' + val;
                  }
                }
                function resetLocal() {
                  if (window.AyushAndroid && window.AyushAndroid.updateServerUrl) {
                    window.AyushAndroid.updateServerUrl('http://127.0.0.1:3000');
                  } else {
                    window.location.href = 'http://127.0.0.1:3000';
                  }
                }
                setInterval(() => {
                  fetch('$current/api/health/live')
                    .then(res => { if (res.ok) window.location.href = '$current'; })
                    .catch(() => {});
                }, 2500);
              </script>
            </body>
            </html>
        """.trimIndent()
        webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
    }

    private fun requestAppPermissions() {
        val perms = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
            perms.add(Manifest.permission.READ_MEDIA_VIDEO)
            perms.add(Manifest.permission.READ_MEDIA_IMAGES)
            perms.add(Manifest.permission.READ_MEDIA_AUDIO)
        } else {
            perms.add(Manifest.permission.READ_EXTERNAL_STORAGE)
            perms.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }

        val ungranted = perms.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (ungranted.isNotEmpty()) {
            requestPermissionLauncher.launch(ungranted.toTypedArray())
        } else {
            checkStoragePermission()
        }
    }

    private fun checkStoragePermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (!Environment.isExternalStorageManager()) {
                AlertDialog.Builder(this)
                    .setTitle("Storage Access Required")
                    .setMessage("AyushServer needs full storage access to browse and process media and PDF files on your device.")
                    .setPositiveButton("Grant Access") { _, _ ->
                        try {
                            val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                                data = Uri.parse("package:$packageName")
                            }
                            startActivity(intent)
                        } catch (e: Exception) {
                            val intent = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                            startActivity(intent)
                        }
                    }
                    .setNegativeButton("Cancel", null)
                    .show()
            }
        }
    }
}
