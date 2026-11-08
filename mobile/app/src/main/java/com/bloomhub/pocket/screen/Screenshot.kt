package com.bloomhub.pocket.screen

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.DisplayMetrics
import java.io.File

/**
 * 截屏（MediaProjection）：授权一次，会话内可反复截。
 * 截图两份：cacheDir（发送用）+ 公共相册 MediaStore（QQ 分享选择器需要）。
 * 任务结束统一清理（cleanup），避免占用存储。
 */
object Screenshot {

    @Volatile var projection: MediaProjection? = null
        private set
    private var reader: ImageReader? = null
    private var display: VirtualDisplay? = null
    private var metrics: DisplayMetrics? = null
    private val createdUris = ArrayList<Uri>()   // 相册副本，清理用
    private val createdFiles = ArrayList<File>() // cache 副本，清理用

    val ready: Boolean get() = projection != null

    fun requestPermission(context: Context) {
        val mpm = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        (context as? android.app.Activity)?.startActivityForResult(mpm.createScreenCaptureIntent(), 2001)
    }

    /** MainActivity.onActivityResult(2001) 里调用 */
    fun init(context: Context, code: Int, data: Intent?): Boolean {
        if (code != android.app.Activity.RESULT_OK || data == null) return false
        return try {
            val mpm = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            teardown()
            projection = mpm.getMediaProjection(code, data)
            metrics = context.resources.displayMetrics
            // Android 14+：createVirtualDisplay 前必须 registerCallback，否则抛 SecurityException；
            // 系统侧停止投递（用户点「停止投递」）时走 onStop 清理，避免持有失效的 projection。
            if (Build.VERSION.SDK_INT >= 34) {
                projection?.registerCallback(object : MediaProjection.Callback() {
                    override fun onStop() { teardown() }
                }, android.os.Handler(android.os.Looper.getMainLooper()))
            }
            projection != null
        } catch (e: Exception) { false }
    }

    /** 截一张；返回 cache 文件路径（失败返回 null） */
    fun take(context: Context): File? {
        val p = projection ?: return null
        val m = metrics ?: context.resources.displayMetrics
        try {
            if (reader == null) {
                reader = ImageReader.newInstance(m.widthPixels, m.heightPixels, PixelFormat.RGBA_8888, 2)
                display = p.createVirtualDisplay(
                    "pocket-shot", m.widthPixels, m.heightPixels, m.densityDpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader!!.surface, null, null
                )
                Thread.sleep(400) // 首帧
            }
            var image: Image? = null
            for (i in 0 until 3) {
                image = reader!!.acquireLatestImage()
                if (image != null) break
                Thread.sleep(200)
            }
            image ?: return null
            val bmp = image.toBitmap2()
            image.close()
            val dir = File(context.cacheDir, "shots").apply { mkdirs() }
            val f = File(dir, "shot-${System.currentTimeMillis()}.jpg")
            f.outputStream().use { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it) }
            bmp.recycle()
            createdFiles.add(f)
            return f
        } catch (e: Exception) {
            return null
        }
    }

    private fun Image.toBitmap2(): Bitmap {
        val plane = planes[0]
        val buffer = plane.buffer
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * width
        val bmp = Bitmap.createBitmap(width + rowPadding / pixelStride, height, Bitmap.Config.ARGB_8888)
        bmp.copyPixelsFromBuffer(buffer)
        // 裁掉 rowPadding
        return if (rowPadding == 0) bmp else Bitmap.createBitmap(bmp, 0, 0, width, height).also { bmp.recycle() }
    }

    /** 最近一张截图（发送用） */
    fun lastShot(context: Context): File? =
        createdFiles.lastOrNull { it.exists() } ?: File(context.cacheDir, "shots").listFiles()?.maxByOrNull { it.name }

    /** 把截图存进公共相册并返回 content:// URI（分享给 QQ 用） */
    fun toGallery(context: Context, file: File): Uri? {
        return try {
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, file.name)
                put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                if (Build.VERSION.SDK_INT >= 29) put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/BloomPocket")
            }
            val uri = context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return null
            context.contentResolver.openOutputStream(uri)?.use { out -> out.write(file.readBytes()) }
            createdUris.add(uri)
            uri
        } catch (e: Exception) { null }
    }

    /** 调起 QQ 分享界面（选联系人发送由 Agent 完成） */
    fun shareToQq(context: Context, uri: Uri): Boolean {
        return try {
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "image/jpeg"
                putExtra(Intent.EXTRA_STREAM, uri)
                setPackage("com.tencent.mobileqq")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            true
        } catch (e: Exception) { false }
    }

    /** 任务结束：删除本任务产生的所有截图（cache + 相册） */
    fun cleanup(context: Context) {
        for (f in createdFiles) f.delete()
        for (u in createdUris) {
            try { context.contentResolver.delete(u, null, null) } catch (_: Exception) {}
        }
        createdFiles.clear()
        createdUris.clear()
    }

    fun teardown() {
        display?.release(); display = null
        reader?.close(); reader = null
        // 先置空再 stop：stop 会同步触发 onStop 回调 → teardown 重入，此时 projection 已为 null，安全
        val p = projection
        projection = null
        p?.stop()
    }
}
