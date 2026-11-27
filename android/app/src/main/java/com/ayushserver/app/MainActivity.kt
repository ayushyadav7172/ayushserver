package com.ayushserver.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.webkit.*
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var swipeRefreshLayout: SwipeRefreshLayout
    private lateinit var progressBar: ProgressBar
    private lateinit var settingsFab: TextView

    private val prefs by lazy { getSharedPreferences("ayush_server_settings", Context.MODE_PRIVATE) }
    private var serverUrl: String
        get() = prefs.getString("custom_server_url", "http://127.0.0.1:3000") ?: "http://127.0.0.1:3000"
        set(value) {
            val cleaned = sanitizeUrl(value)
            prefs.edit().putString("custom_server_url", cleaned).apply()
        }

    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (filePathCallback != null) {
            val results = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            filePathCallback?.onReceiveValue(results)
            filePathCallback = null
        }
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

        // Floating Settings & IP Switcher button (bottom right corner)
        val bgDrawable = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.parseColor("#CC181A20"))
            setStroke(2, Color.parseColor("#38BDF8"))
        }

        settingsFab = TextView(this).apply {
            text = "🌐"
            textSize = 18f
            gravity = Gravity.CENTER
            background = bgDrawable
            alpha = 0.85f
            contentDescription = "Change Server IP"
            val size = (44 * resources.displayMetrics.density).toInt()
            val margin = (16 * resources.displayMetrics.density).toInt()
            layoutParams = FrameLayout.LayoutParams(size, size).apply {
                gravity = Gravity.BOTTOM or Gravity.END
                setMargins(margin, margin, margin, margin + (40 * resources.displayMetrics.density).toInt())
            }
            setOnClickListener {
                showServerUrlDialog()
            }
        }

        rootLayout.addView(swipeRefreshLayout)
        rootLayout.addView(progressBar)
        rootLayout.addView(settingsFab)
        setContentView(rootLayout)
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
        settings.setSupportZoom(false)

        webView.addJavascriptInterface(WebAppInterface(), "AyushAndroid")

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

                val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                    type = "*/*"
                    addCategory(Intent.CATEGORY_OPENABLE)
                }
                try {
                    fileChooserLauncher.launch(intent)
                } catch (e: Exception) {
                    this@MainActivity.filePathCallback = null
                    return false
                }
                return true
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
