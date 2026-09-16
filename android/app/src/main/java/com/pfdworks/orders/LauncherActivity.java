/*
 * Copyright 2020 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.pfdworks.orders;

import android.content.Context;
import android.content.RestrictionsManager;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;

/**
 * The one thing this shell adds to Bubblewrap's stock launcher: it tells
 * the page which tablet it is running on, so the tablet boots straight
 * into its restaurant with nobody typing anything (Workstream I1, 1b).
 *
 * The reference goes on the start URL as ?device=<ref>. It is, in order:
 *
 *   1b-i   the value Hexnode pushed through Android Enterprise managed
 *          app configuration under the key "device_ref"
 *          (res/xml/app_restrictions.xml) - the tablet's serial, filled in
 *          per device by the MDM. The app cannot read the hardware serial
 *          itself on Android 10+, and does not try.
 *   1b-ii  failing that, the install's own ANDROID_ID, prefixed "aid:" so
 *          the bridge can tell the two apart. Stable for the life of the
 *          install, needs no permission, and lets the office assign a
 *          tablet it has never heard of from its "new tablets seen" list.
 *
 * Nothing else about the launch changes. The page does the rest.
 */
public class LauncherActivity
        extends com.google.androidbrowserhelper.trusted.LauncherActivity {

    /** Must match the key in res/xml/app_restrictions.xml and the Hexnode App Configuration. */
    static final String DEVICE_REF_KEY = "device_ref";
    static final String DEVICE_PARAM = "device";
    static final String ANDROID_ID_PREFIX = "aid:";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Setting an orientation crashes the app due to the transparent background on Android 8.0
        // Oreo and below. We only set the orientation on Oreo and above. This only affects the
        // splash screen and Chrome will still respect the orientation.
        // See https://github.com/GoogleChromeLabs/bubblewrap/issues/496 for details.
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.O) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT);
        } else {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }
    }

    @Override
    protected Uri getLaunchingUrl() {
        // Get the original launch Url.
        Uri uri = super.getLaunchingUrl();

        String ref = deviceRef();
        if (ref != null && uri.getQueryParameter(DEVICE_PARAM) == null) {
            uri = uri.buildUpon().appendQueryParameter(DEVICE_PARAM, ref).build();
        }

        return uri;
    }

    /** The managed-configuration value if the MDM set one, else "aid:" + ANDROID_ID, else null. */
    private String deviceRef() {
        try {
            RestrictionsManager rm = (RestrictionsManager) getSystemService(Context.RESTRICTIONS_SERVICE);
            if (rm != null) {
                Bundle restrictions = rm.getApplicationRestrictions();
                if (restrictions != null) {
                    String managed = restrictions.getString(DEVICE_REF_KEY);
                    if (managed != null && !managed.trim().isEmpty()) {
                        return managed.trim();
                    }
                }
            }
        } catch (RuntimeException ignored) {
            // No restrictions service, or a policy that refuses it. Fall through.
        }
        try {
            String androidId = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
            if (androidId != null && !androidId.trim().isEmpty()) {
                return ANDROID_ID_PREFIX + androidId.trim();
            }
        } catch (RuntimeException ignored) {
            // Nothing to identify this install by. The page shows the link code.
        }
        return null;
    }
}
