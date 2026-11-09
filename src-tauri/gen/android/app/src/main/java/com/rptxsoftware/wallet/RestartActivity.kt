package com.rptxsoftware.wallet

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Process

// Start Over's second half (w_mobile.rs, M_Restart). It runs in a process of its own
// (":restart", AndroidManifest.xml): it ends Laurel's process, opens Laurel in a new one,
// and ends its own. Both end by kill, not exit: a normal exit runs C++ destructors under
// Android's render threads, which abort (lib.rs, Sys_End)
class RestartActivity : Activity() {
  companion object {
    const val PID = "pid"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val laurel = intent.getIntExtra(PID, -1)
    if (laurel > 0) {
      Process.killProcess(laurel)
    }
    packageManager.getLaunchIntentForPackage(packageName)?.let {
      startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
    }
    finish()
    Process.killProcess(Process.myPid())
  }
}
