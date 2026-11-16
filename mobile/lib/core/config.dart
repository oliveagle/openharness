/// Runtime configuration for the phone app.
class AppConfig {
  /// Base URL of the central backend (control plane + ws hub).
  final String apiBaseUrl;
  final String autonomousEnv;

  const AppConfig({required this.apiBaseUrl, this.autonomousEnv = 'prod'});

  /// A local deployment can compile in its own API origin. The normal package
  /// keeps the cloud default; a VPN/LAN release can point at a private host.
  static const String apiBaseUrlOverride = String.fromEnvironment(
    'HARNESS_API_BASE_URL',
    defaultValue: cloudApiBaseUrl,
  );
  static const String cloudApiBaseUrl = 'https://harness-api.autonomous.ai';

  /// A local deployment build: it never offers cloud account sign-in and starts
  /// on the local pair QR. Compile with HARNESS_LOCAL_MODE=true or derive it from
  /// a non-cloud HARNESS_API_BASE_URL.
  static const bool localMode = bool.fromEnvironment(
    'HARNESS_LOCAL_MODE',
    defaultValue: apiBaseUrlOverride != cloudApiBaseUrl,
  );

  /// Where the workstation's local QR server is exposed. Only local builds read
  /// this; the normal cloud package keeps its cloud onboarding.
  static const String localPairHostOverride = String.fromEnvironment(
    'HARNESS_LOCAL_PAIR_HOST',
    defaultValue: '',
  );

  /// Prefer the injected pair host; otherwise use the host from the injected API origin. A normal
  /// cloud package has no pair server and keeps the cloud onboarding.
  static String get localPairHost {
    if (localPairHostOverride.isNotEmpty) return localPairHostOverride;
    return Uri.tryParse(apiBaseUrlOverride)?.host ?? '';
  }

  static String get localPairUrl => 'http://$localPairHost:8089/pair';

  static const AppConfig dev = AppConfig(
    apiBaseUrl: apiBaseUrlOverride,
    autonomousEnv: 'prod',
  );

  /// HTTPS->wss, HTTP->ws for the hub endpoint.
  String get wsBaseUrl {
    final uri = Uri.parse(apiBaseUrl);
    final scheme = uri.scheme == 'https' ? 'wss' : 'ws';
    return Uri(
      scheme: scheme,
      host: uri.host,
      port: uri.hasPort ? uri.port : null,
    ).toString().replaceFirst(RegExp(r'/$'), '');
  }
}
