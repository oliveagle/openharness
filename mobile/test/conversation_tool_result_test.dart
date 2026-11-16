// A tool row on the phone shows what the tool printed.
//
// The transcript a machine keeps records a tool's result beside the call that
// made it. The phone used to show only the call's one-line summary, so a
// Codex session read as a wall of "Bash — Chunk ID: f13c4e": the header Codex
// wraps its result in, and nothing of the result itself.
//
// The result is what a reader on a phone is here for, so the row carries it.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_conversation.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import 'voice_fakes.dart';

/// A machine whose transcript holds one shell call and its result.
class _Conn extends WsConn {
  _Conn()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'session_get') return const {};
    return {
      'id': 's1',
      'title': 'Ship it',
      'events': [
        {
          'type': 'tool_start',
          'payload': {'id': 't1', 'tool': 'Bash', 'input': {'command': 'ls'}},
        },
        {
          'type': 'tool_end',
          'payload': {
            'id': 't1',
            'tool': 'Bash',
            'summary': 'Chunk ID: f13c4e',
            'output': 'server.go\nhandler.go',
          },
        },
      ],
    };
  }
}

void main() {
  late AppNotifier notifier;
  late VoiceInputController voice;
  late ValueNotifier<String> language;

  setUp(() {
    notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      connectionForTest: (_) => _Conn(),
    );
    const machine = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Studio',
    );
    notifier.machines = [machine];
    notifier.machineStates['m'] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = const [Agent(id: 'a', sessionId: 's1', name: 'Agent')];
    language = ValueNotifier('en');
    voice = VoiceInputController(
      transcriber: FakeTranscriber().call,
      recorder: FakeVoiceRecorder(),
      language: language,
    );
  });

  tearDown(() {
    voice.dispose();
    language.dispose();
    notifier.dispose();
  });

  testWidgets('the row carries the result, not the summary', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: TerminalPage(
          notifier: notifier,
          machineId: 'm',
          agentId: 'a',
          voice: voice,
        ),
      ),
    );
    await tester.pumpAndSettle();

    // The result is on screen, with the tool that printed it.
    expect(find.textContaining('server.go'), findsOneWidget);
    // The summary was the header Codex wraps the result in: it says nothing.
    expect(find.textContaining('Chunk ID'), findsNothing);
  });
}
