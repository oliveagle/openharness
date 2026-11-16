// A tool row on the phone shows what the tool printed.
//
// The transcript a machine keeps records a tool's result beside the call that
// made it. The phone used to show only the call's one-line summary, so a
// Codex session read as a wall of "Bash — Chunk ID: f13c4e": the header Codex
// wraps its result in, and nothing of the result itself.
//
// The result is what a reader on a phone is here for, so the row carries it. A
// tool that printed nothing keeps its own name — "Bash completed" says less
// than "Bash" does.
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

/// A machine whose transcript holds the events it is given.
class _Conn extends WsConn {
  _Conn(this.events)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final List<Map<String, dynamic>> events;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'session_get') return const {};
    return {'id': 's1', 'title': 'Ship it', 'events': events};
  }
}

/// One shell call that printed something.
final _shellCall = <Map<String, dynamic>>[
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
];

/// One shell call that printed nothing.
final _silentCall = <Map<String, dynamic>>[
  {
    'type': 'tool_start',
    'payload': {'id': 't2', 'tool': 'Bash', 'input': {'command': 'true'}},
  },
  {
    'type': 'tool_end',
    'payload': {'id': 't2', 'tool': 'Bash', 'summary': 'Bash completed', 'output': ''},
  },
];

void main() {
  late AppNotifier notifier;
  late VoiceInputController voice;
  late ValueNotifier<String> language;

  setUp(() {
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

  Future<void> open(WidgetTester tester, List<Map<String, dynamic>> events) async {
    notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      connectionForTest: (_) => _Conn(events),
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
  }

  testWidgets('the row carries the result, not the summary', (tester) async {
    await open(tester, _shellCall);

    // The result is on screen, with the tool that printed it.
    expect(find.textContaining('server.go'), findsOneWidget);
    // The summary was the header Codex wraps the result in: it says nothing.
    expect(find.textContaining('Chunk ID'), findsNothing);
  });

  testWidgets('a tool that printed nothing keeps just its name', (tester) async {
    await open(tester, _silentCall);

    expect(find.text('Bash'), findsOneWidget);
    // "Bash — Bash completed" says less than "Bash" does.
    expect(find.textContaining('—'), findsNothing);
  });
}
