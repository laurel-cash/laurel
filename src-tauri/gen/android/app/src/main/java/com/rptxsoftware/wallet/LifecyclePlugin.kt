package com.rptxsoftware.wallet

import android.app.Activity
import android.content.Intent
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class WatchArgs {
  lateinit var channel: Channel
}

@TauriPlugin
class LifecyclePlugin(private val activity: Activity) : Plugin(activity), DefaultLifecycleObserver {
  private var background: Channel? = null

  init {
    (activity as LifecycleOwner).lifecycle.addObserver(this)
  }

  // Start Over (w_mobile.rs, M_Restart): RestartActivity, in a process of its own, ends this
  // one and opens Laurel again. Resolved first: the answer can't come from a process that's gone
  @Command
  fun restart(invoke: Invoke) {
    invoke.resolve()
    val intent = Intent(activity, RestartActivity::class.java)
      .putExtra(RestartActivity.PID, android.os.Process.myPid())
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    activity.startActivity(intent)
  }

  @Command
  fun watch(invoke: Invoke) {
    background = invoke.parseArgs(WatchArgs::class.java).channel
    invoke.resolve()
  }

  // Laurel decides what hiding means (w_mobile.rs, M_Hidden): the time the person allows.
  // Coming back is the page's to report (M_Shown_f): it keeps the wallets covered until the answer
  override fun onStop(owner: LifecycleOwner) {
    android.util.Log.i("LaurelLifecycle", "activity stopped; channel=${background != null}")
    background?.send(JSObject().put("visible", false))
  }
}
