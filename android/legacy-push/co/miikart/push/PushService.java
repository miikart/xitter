package co.miikart.push;

import android.app.Activity;
import android.app.Application;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Resources;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.service.notification.StatusBarNotification;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.ImageView;
import android.widget.PopupWindow;
import android.widget.TextView;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.Reader;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import org.json.JSONArray;
import org.json.JSONObject;

public final class PushService extends Service {
	private static final String TAG = "MiikartPush";
	private static final String CHANNEL = "miikart_activity";
	private static final String FALLBACK_ORIGIN = "http://miikart.co";
	private static final int ALERT_ID_BASE = 0x40000;
	private static final int ALERT_ID_MASK = 0x3ffff;
	private static final int MAX_BODY = 512 * 1024;
	private static final long IN_APP_DURATION_MS = 4500L;

	private static final Set<Integer> postedIds = Collections.synchronizedSet(new HashSet<Integer>());
	private static volatile WeakReference<Activity> currentActivity;
	private static volatile PopupWindow activeBanner;

	private NotificationManager manager;
	private Handler mainHandler;
	private volatile boolean running;
	private volatile HttpURLConnection connection;
	private Thread worker;

	public static final class BootReceiver extends BroadcastReceiver {
		public void onReceive(Context context, Intent intent) {
			ensure(context);
		}
	}

	// Keep API 26+ types in a nested helper class so Dalvik on KitKat (API 19)
	// verifies PushService cleanly without referencing NotificationChannel directly.
	private static final class Api26 {
		static void createChannels(Context context) {
			NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
			if (nm == null) return;
			NotificationChannel alerts = new NotificationChannel(CHANNEL, "Messages and activity", NotificationManager.IMPORTANCE_DEFAULT);
			alerts.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
			nm.createNotificationChannel(alerts);
		}

		static Notification.Builder builder(Context context, String channel) {
			return new Notification.Builder(context, channel);
		}
	}

	private static final class Api23 {
		static void clearTaggedAlerts(Context context) {
			NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
			if (nm == null) return;
			StatusBarNotification[] active = nm.getActiveNotifications();
			if (active == null) return;
			for (int i = 0; i < active.length; i++) {
				StatusBarNotification sbn = active[i];
				int id = sbn.getId();
				if (id >= ALERT_ID_BASE && id <= ALERT_ID_BASE + ALERT_ID_MASK) {
					nm.cancel(sbn.getTag(), id);
				}
			}
		}
	}

	private static final class Api14 {
		static void registerLifecycle(final Application application) {
			application.registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
				public void onActivityResumed(Activity activity) {
					currentActivity = new WeakReference<Activity>(activity);
					if (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != 0) {
						SharedPreferences prefs = application.getSharedPreferences("miikart_push", 0);
						if (!prefs.getBoolean("permission_asked", false)) {
							prefs.edit().putBoolean("permission_asked", true).commit();
							activity.requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 0x53de);
						}
					}
					ensure(application);
				}

				public void onActivityPaused(Activity activity) {
					WeakReference<Activity> ref = currentActivity;
					if (ref != null && ref.get() == activity) {
						currentActivity = null;
					}
					dismissBanner();
				}

				public void onActivityCreated(Activity activity, Bundle savedInstanceState) {}
				public void onActivityStarted(Activity activity) {}
				public void onActivityStopped(Activity activity) {}
				public void onActivitySaveInstanceState(Activity activity, Bundle outState) {}
				public void onActivityDestroyed(Activity activity) {}
			});
		}
	}

	public static void install(Application application) {
		if (Build.VERSION.SDK_INT >= 26) {
			Api26.createChannels(application);
		}
		if (Build.VERSION.SDK_INT >= 14) {
			Api14.registerLifecycle(application);
		}
		ensure(application);
	}

	public static void ensure(Context context) {
		Context app = context.getApplicationContext();
		if (app == null) app = context;
		Intent intent = new Intent(app, PushService.class);
		if (session(app) == null) {
			clearAlerts(app);
			app.stopService(intent);
			return;
		}
		if (Build.VERSION.SDK_INT >= 24) {
			NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
			if (nm != null && !nm.areNotificationsEnabled()) {
				app.stopService(intent);
				return;
			}
		}
		try {
			app.startService(intent);
		} catch (RuntimeException e) {
			Log.w(TAG, "Unable to start PushService", e);
		}
	}

	private static String[] session(Context context) {
		try {
			Class<?> controllerClass = Class.forName("com.twitter.applib.client.a");
			Object controller = controllerClass.getMethod("a", Context.class).invoke(null, context.getApplicationContext());
			if (controller == null) return null;
			Object active = controller.getClass().getMethod("h").invoke(controller);
			if (active == null) return null;
			Long userIdObj = (Long) active.getClass().getMethod("g").invoke(active);
			long userId = userIdObj != null ? userIdObj.longValue() : 0L;
			Object oauth = active.getClass().getMethod("h").invoke(active);
			if (userId <= 0L || oauth == null) return null;
			String token = (String) oauth.getClass().getField("b").get(oauth);
			if (token == null || token.length() == 0) return null;
			return new String[] { Long.toString(userId), token };
		} catch (Exception e) {
			return null;
		}
	}

	private static void clearAlerts(Context context) {
		NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
		if (nm != null) {
			synchronized (postedIds) {
				for (Integer id : postedIds) {
					nm.cancel(id.intValue());
				}
				postedIds.clear();
			}
		}
		if (Build.VERSION.SDK_INT >= 23) {
			Api23.clearTaggedAlerts(context);
		}
	}

	private static void dismissBanner() {
		PopupWindow popup = activeBanner;
		activeBanner = null;
		if (popup != null) {
			try {
				if (popup.isShowing()) popup.dismiss();
			} catch (Exception ignored) {
			}
		}
	}

	private String origin() {
		try {
			Resources res = getResources();
			int id = res.getIdentifier("base_host", "string", getPackageName());
			if (id != 0) {
				String host = res.getString(id);
				if (host != null && host.length() > 0) {
					while (host.endsWith("/")) {
						host = host.substring(0, host.length() - 1);
					}
					return host;
				}
			}
		} catch (Exception ignored) {
		}
		return FALLBACK_ORIGIN;
	}

	private int drawableId(String name, int fallback) {
		int id = getResources().getIdentifier(name, "drawable", getPackageName());
		return id != 0 ? id : fallback;
	}

	private int statIcon(String kind) {
		int def = drawableId("ic_stat_twitter", android.R.drawable.ic_dialog_info);
		if ("like".equals(kind)) return drawableId("ic_stat_favorite", def);
		if ("repost".equals(kind)) return drawableId("ic_stat_retweet", def);
		if ("mention".equals(kind) || "reply".equals(kind) || "quote".equals(kind)) return drawableId("ic_stat_mention", def);
		if ("dm".equals(kind)) return drawableId("ic_stat_dm", def);
		return def;
	}

	private int inAppIcon(String kind) {
		int def = statIcon(kind);
		if ("like".equals(kind)) return drawableId("ic_notif_favorite", def);
		if ("repost".equals(kind)) return drawableId("ic_notif_retweet", def);
		if ("follow".equals(kind)) return drawableId("ic_notif_follow", def);
		if ("mention".equals(kind) || "reply".equals(kind) || "quote".equals(kind)) return drawableId("ic_notif_mention", def);
		return def;
	}

	private static String normalizeUrl(String raw) {
		if (raw == null || raw.length() == 0) return "twitter://mentions";
		if (raw.startsWith("twitter://status?id=")) {
			return "twitter://status?status_id=" + raw.substring("twitter://status?id=".length());
		}
		return raw;
	}

	private Intent openIntent(String url) {
		Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(normalizeUrl(url)));
		intent.setPackage(getPackageName());
		intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
		return intent;
	}

	private PendingIntent openPendingIntent(Intent intent, int requestCode) {
		int flags = PendingIntent.FLAG_UPDATE_CURRENT;
		if (Build.VERSION.SDK_INT >= 23) flags |= 0x04000000; // FLAG_IMMUTABLE
		return PendingIntent.getActivity(this, requestCode, intent, flags);
	}

	private Notification.Builder builder(String channel) {
		if (Build.VERSION.SDK_INT >= 26) {
			return Api26.builder(this, channel);
		}
		return new Notification.Builder(this);
	}

	@SuppressWarnings("deprecation")
	private static Notification buildNotification(Notification.Builder b) {
		if (Build.VERSION.SDK_INT >= 16) {
			return b.build();
		}
		return b.getNotification();
	}

	private static void maybeConfigureTls(HttpURLConnection conn) {
		if (!(conn instanceof HttpsURLConnection)) return;
		try {
			Class<?> trustCls = Class.forName("com.twitter.library.network.ssl.TrustAll");
			X509TrustManager tm = (X509TrustManager) trustCls.getConstructor().newInstance();
			SSLContext sc = SSLContext.getInstance("TLS");
			sc.init(null, new TrustManager[] { tm }, new SecureRandom());
			((HttpsURLConnection) conn).setSSLSocketFactory(sc.getSocketFactory());
		} catch (Exception ignored) {
		}
	}

	public void onCreate() {
		super.onCreate();
		manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
		mainHandler = new Handler(Looper.getMainLooper());
		if (Build.VERSION.SDK_INT >= 26) {
			Api26.createChannels(this);
		}
	}

	public int onStartCommand(Intent intent, int flags, int startId) {
		if (worker == null || !worker.isAlive()) {
			running = true;
			worker = new Thread(new Runnable() {
				public void run() {
					listen();
				}
			}, TAG);
			worker.start();
		}
		return START_STICKY;
	}

	public void onDestroy() {
		running = false;
		HttpURLConnection conn = connection;
		if (conn != null) conn.disconnect();
		if (worker != null) worker.interrupt();
		super.onDestroy();
	}

	public IBinder onBind(Intent intent) {
		return null;
	}

	private JSONObject request(String token, String query) throws Exception {
		String url = origin() + "/1.1/xitter/push/poll.json?" + query;
		HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
		maybeConfigureTls(conn);
		connection = conn;
		conn.setInstanceFollowRedirects(false);
		conn.setConnectTimeout(15000);
		conn.setReadTimeout(35000);
		conn.setRequestProperty("Authorization", "OAuth oauth_token=\"" + URLEncoder.encode(token, "UTF-8") + "\"");
		conn.setRequestProperty("Accept-Encoding", "identity");
		conn.setRequestProperty("User-Agent", "TwitterAndroid/4.1.9 MiikartPush/1");
		try {
			int code = conn.getResponseCode();
			if (code == 401 || code == 403) {
				clearAlerts(this);
				running = false;
				stopSelf();
				return null;
			}
			if (code != 200) {
				throw new IOException("HTTP " + code);
			}
			StringBuilder sb = new StringBuilder();
			Reader reader = new InputStreamReader(conn.getInputStream(), "UTF-8");
			try {
				char[] buf = new char[4096];
				int n;
				while ((n = reader.read(buf)) != -1) {
					sb.append(buf, 0, n);
					if (sb.length() > MAX_BODY) {
						throw new IOException("Push response too large");
					}
				}
			} finally {
				try {
					reader.close();
				} catch (IOException ignored) {
				}
			}
			return new JSONObject(sb.toString());
		} finally {
			conn.disconnect();
			connection = null;
		}
	}

	private void showInAppBanner(final String body, final Intent clickIntent, final int iconRes, final int notifId) {
		if (mainHandler == null) return;
		mainHandler.post(new Runnable() {
			public void run() {
				WeakReference<Activity> ref = currentActivity;
				final Activity activity = ref != null ? ref.get() : null;
				if (activity == null || activity.isFinishing()) return;
				Window window = activity.getWindow();
				View decor = window != null ? window.getDecorView() : null;
				if (decor == null || decor.getWindowToken() == null) return;

				try {
					Resources res = activity.getResources();
					String pkg = activity.getPackageName();
					int layoutId = res.getIdentifier("in_app_notification", "layout", pkg);
					if (layoutId == 0) return;

					dismissBanner();
					View view = activity.getLayoutInflater().inflate(layoutId, null);
					int iconId = res.getIdentifier("icon", "id", pkg);
					int textId = res.getIdentifier("text", "id", pkg);
					if (iconId != 0) {
						View iv = view.findViewById(iconId);
						if (iv instanceof ImageView) ((ImageView) iv).setImageResource(iconRes);
					}
					if (textId != 0) {
						View tv = view.findViewById(textId);
						if (tv instanceof TextView) ((TextView) tv).setText(body);
					}

					final PopupWindow popup = new PopupWindow(view, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
					int animId = res.getIdentifier("InAppNotificationWindow", "style", pkg);
					if (animId != 0) popup.setAnimationStyle(animId);
					activeBanner = popup;

					view.setOnClickListener(new View.OnClickListener() {
						public void onClick(View v) {
							try {
								activity.startActivity(clickIntent);
							} catch (Exception ignored) {
							}
							if (activeBanner == popup) activeBanner = null;
							try {
								if (popup.isShowing()) popup.dismiss();
							} catch (Exception ignored) {
							}
							if (manager != null) manager.cancel(notifId);
							postedIds.remove(Integer.valueOf(notifId));
						}
					});

					popup.showAtLocation(decor, Gravity.BOTTOM, 0, 0);
					mainHandler.postDelayed(new Runnable() {
						public void run() {
							if (activeBanner == popup) activeBanner = null;
							try {
								if (popup.isShowing()) popup.dismiss();
							} catch (Exception ignored) {
							}
						}
					}, IN_APP_DURATION_MS);
				} catch (Exception e) {
					Log.w(TAG, "In-app banner failed", e);
				}
			}
		});
	}

	private void deliverEvent(JSONObject item) throws Exception {
		String key = item.getString("key");
		String kind = item.optString("kind", "");
		String title = item.optString("title", "Twitter");
		String body = item.getString("body");
		String url = item.optString("url", "twitter://mentions");

		int notifId = ALERT_ID_BASE + (key.hashCode() & ALERT_ID_MASK);
		Intent intent = openIntent(url);
		PendingIntent pi = openPendingIntent(intent, notifId);

		Notification.Builder b = builder(CHANNEL)
			.setSmallIcon(statIcon(kind))
			.setTicker(body)
			.setContentTitle(title)
			.setContentText(body)
			.setAutoCancel(true)
			.setDefaults(Notification.DEFAULT_ALL)
			.setContentIntent(pi);

		if (Build.VERSION.SDK_INT >= 16) {
			b.setStyle(new Notification.BigTextStyle().bigText(body));
			b.setPriority(Notification.PRIORITY_DEFAULT);
		}
		if (Build.VERSION.SDK_INT >= 21) {
			b.setVisibility(Notification.VISIBILITY_PRIVATE);
			b.setCategory("dm".equals(kind) ? Notification.CATEGORY_MESSAGE : Notification.CATEGORY_SOCIAL);
		}

		if (manager != null) {
			manager.notify(notifId, buildNotification(b));
			postedIds.add(Integer.valueOf(notifId));
		}
		showInAppBanner(body, intent, inAppIcon(kind), notifId);
	}

	private void listen() {
		String lastAccount = "";
		int backoff = 1000;
		Log.i(TAG, "Push polling started against " + origin());
		while (running) {
			try {
				String[] sess = session(this);
				if (sess == null) {
					Log.i(TAG, "No active session; stopping PushService");
					stopSelf();
					return;
				}
				SharedPreferences prefs = getSharedPreferences("miikart_push_" + sess[0], 0);
				String dmCursor = prefs.getString("dm_cursor", "");
				long activityCursor = prefs.getLong("activity_cursor", -1L);
				String query = (dmCursor.length() == 0 || activityCursor < 0L)
					? "bootstrap=1"
					: "dm_cursor=" + dmCursor + "&activity_cursor=" + activityCursor;

				if (!lastAccount.equals(sess[0])) {
					SharedPreferences global = getSharedPreferences("miikart_push", 0);
					if (!sess[0].equals(global.getString("account", ""))) {
						clearAlerts(this);
					}
					global.edit().putString("account", sess[0]).commit();
					lastAccount = sess[0];
				}

				JSONObject res = request(sess[1], query);
				if (!running || res == null) return;

				String[] after = session(this);
				if (after == null || !after[0].equals(sess[0]) || !after[1].equals(sess[1])) {
					continue;
				}

				JSONArray events = res.optJSONArray("events");
				if (events != null) {
					for (int i = 0; i < events.length(); i++) {
						if (!running) return;
						deliverEvent(events.getJSONObject(i));
					}
				}

				prefs.edit()
					.putString("dm_cursor", res.getString("dm_cursor"))
					.putLong("activity_cursor", res.getLong("activity_cursor"))
					.commit();
				backoff = 1000;
			} catch (Exception e) {
				if (!running) return;
				Log.w(TAG, "Poll error, retrying in " + backoff + "ms: " + e);
				try {
					Thread.sleep(backoff);
				} catch (InterruptedException ie) {
					return;
				}
				backoff = Math.min(backoff * 2, 60000);
			}
		}
	}
}
