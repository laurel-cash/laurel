/* Copyright (C) 2026 The Laurel authors. Released under the MIT License; see LICENSE. */
package com.rptxsoftware.wallet

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract as Documents
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.Executors

@InvokeArg
class DocumentArgs {
  var uri: String = ""
  var mode: String = "r"
  var name: String = ""
  var source: String = ""
  var max: Int = 0
}

// No webview command permissions are granted for this plugin. Rust alone calls it.
@TauriPlugin
class DocumentsPlugin(private val activity: Activity) : Plugin(activity) {
  private val resolver = activity.contentResolver
  private val io = Executors.newSingleThreadExecutor()
  private var choosing = false

  private fun document(text: String): Uri {
    val uri = Uri.parse(text)
    require(uri.scheme == "content") { "A granted document URI is required." }
    return uri
  }

  private fun root(uri: Uri): Uri = Documents.buildDocumentUriUsingTree(uri, Documents.getTreeDocumentId(uri))

  private fun displayName(uri: Uri): String {
    val target = if (Documents.isTreeUri(uri) && !Documents.isDocumentUri(activity, uri)) root(uri) else uri
    return resolver.query(target, arrayOf(Documents.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { cursor ->
      require(cursor.moveToFirst()) { "The document name is unavailable." }
      cursor.getString(0)
    } ?: error("The document name is unavailable.")
  }

  // Only children whose names pass keep are returned or counted: a folder in daily use
  // (a cloud drive's root) holds thousands of other files. At most max of them: the
  // limit and its error are w_documents.rs's (Doc_List), which asks for one past it.
  private fun entries(tree: Uri, max: Int = Int.MAX_VALUE, keep: (String) -> Boolean): List<Pair<String, Uri>> {
    val children = Documents.buildChildDocumentsUriUsingTree(tree, Documents.getTreeDocumentId(tree))
    val found = mutableListOf<Pair<String, Uri>>()
    resolver.query(children, arrayOf(Documents.Document.COLUMN_DOCUMENT_ID, Documents.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { cursor ->
      while (cursor.moveToNext()) {
        val name = cursor.getString(1) ?: continue
        if (!keep(name)) continue
        if (found.size >= max) break
        found.add(name to Documents.buildDocumentUriUsingTree(tree, cursor.getString(0)))
      }
    } ?: error("The document provider could not read this folder.")
    return found
  }

  private fun child(tree: Uri, name: String): Uri? {
    require(name.isNotEmpty() && !name.contains('/') && !name.contains('\\')) { "Invalid document name." }
    val matches = entries(tree) { it == name }
    require(matches.size <= 1) { "The provider returned duplicate document names." }
    return matches.firstOrNull()?.second
  }

  private fun work(invoke: Invoke, operation: (DocumentArgs) -> JSObject) {
    val args = invoke.parseArgs(DocumentArgs::class.java)
    io.execute {
      try { invoke.resolve(operation(args)) }
      catch (e: Exception) { invoke.reject(e.message ?: "The document provider failed.") }
    }
  }

  @Command
  fun pick(invoke: Invoke) {
    if (choosing) { invoke.reject("A document picker is already open."); return }
    try {
      val args = invoke.parseArgs(DocumentArgs::class.java)
      val action = when (args.mode) {
        "folder" -> Intent.ACTION_OPEN_DOCUMENT_TREE
        "save" -> Intent.ACTION_CREATE_DOCUMENT
        "read" -> Intent.ACTION_OPEN_DOCUMENT
        else -> error("Invalid document picker mode.")
      }
      val intent = Intent(action).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        if (args.mode != "folder") {
          addCategory(Intent.CATEGORY_OPENABLE)
          type = "application/octet-stream"
          if (args.mode == "read") type = "*/*"
          if (args.mode == "save") putExtra(Intent.EXTRA_TITLE, args.name)
        }
      }
      choosing = true
      startActivityForResult(invoke, intent, "picked")
    } catch (e: Exception) {
      choosing = false
      invoke.reject(e.message ?: "Could not open the document picker.")
    }
  }

  @ActivityCallback
  fun picked(invoke: Invoke, result: ActivityResult) {
    choosing = false
    try {
      if (result.resultCode == Activity.RESULT_CANCELED) { invoke.resolve(JSObject()); return }
      require(result.resultCode == Activity.RESULT_OK) { "The document picker failed." }
      val data = result.data ?: error("The document picker returned no selection.")
      val uri = data.data ?: error("The document picker returned no URI.")
      val flags = data.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      resolver.takePersistableUriPermission(uri, flags)
      invoke.resolve(JSObject().put("uri", uri.toString()))
    } catch (e: Exception) { invoke.reject(e.message ?: "Could not retain access to the selection.") }
  }

  @Command
  fun open(invoke: Invoke) = work(invoke) { args ->
    require(args.mode == "r" || args.mode == "wt") { "Invalid document access mode." }
    val fd = resolver.openFileDescriptor(document(args.uri), args.mode) ?: error("The document is unavailable.")
    JSObject().put("fd", fd.detachFd())
  }

  @Command
  fun list(invoke: Invoke) = work(invoke) { args ->
    val out = JSArray()
    require(args.name.isNotEmpty() && args.max > 0) { "A name prefix and a limit are required." }
    entries(document(args.uri), args.max) { it.startsWith(args.name) }.forEach { (name, uri) -> out.put(JSObject().put("name", name).put("uri", uri.toString())) }
    JSObject().put("entries", out)
  }

  @Command
  fun name(invoke: Invoke) = work(invoke) { args ->
    JSObject().put("name", displayName(document(args.uri)))
  }

  @Command
  fun create(invoke: Invoke) = work(invoke) { args ->
    val tree = document(args.uri)
    require(child(tree, args.name) == null) { "A document with that name already exists." }
    val uri = Documents.createDocument(resolver, root(tree), "application/octet-stream", args.name) ?: error("Could not create the document.")
    try { require(displayName(uri) == args.name) { "This provider cannot preserve sync document names." } }
    catch (e: Exception) { Documents.deleteDocument(resolver, uri); throw e }
    JSObject().put("uri", uri.toString())
  }

  @Command
  fun remove(invoke: Invoke) = work(invoke) { args ->
    child(document(args.uri), args.name)?.let { require(Documents.deleteDocument(resolver, it)) { "Could not remove the document." } }
    JSObject()
  }

  @Command
  fun publish(invoke: Invoke) = work(invoke) { args ->
    val tree = document(args.uri)
    val source = document(args.source)
    require(entries(tree) { it.startsWith(".laurel-") }.any { it.second == source }) { "The temporary document is outside the chosen folder." }
    val old = child(tree, args.name)
    var backup: Uri? = null
    if (old != null) {
      backup = Documents.renameDocument(resolver, old, ".laurel-${java.util.UUID.randomUUID()}.bak") ?: error("Could not preserve the previous snapshot.")
    }
    var published: Uri? = null
    try {
      published = Documents.renameDocument(resolver, source, args.name) ?: error("Could not publish the snapshot.")
      require(displayName(published) == args.name) { "This provider cannot preserve sync document names." }
    } catch (e: Exception) {
      published?.let { Documents.deleteDocument(resolver, it) }
      backup?.let { Documents.renameDocument(resolver, it, args.name) }
      throw e
    }
    backup?.let { Documents.deleteDocument(resolver, it) }
    JSObject()
  }
}
