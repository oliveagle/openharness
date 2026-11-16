// The title over a conversation stays in sight.
//
// A terminal's title slides away while its scrollback is read — see
// [TerminalChromeScroll]. A terminal is a stream, and reading its history means
// scrolling back into it, so the header gets out of the way and comes back at
// the end of the output.
//
// A conversation is a chat: it is read by scrolling too, and the row that says
// WHICH agent is talking has to stay in sight while it is read. A title that
// scrolls off is a title somebody has to scroll back up to read, which is the
// opposite of what it is for.
//
// This is the phone's own path, not a corner: a machine whose backend cannot
// stream a live terminal (Herdr) shows the agent's native transcript instead,
// and that transcript is what the reader is reading.
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

/// A machine that answers a transcript read with a long exchange in it.
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
        for (var i = 0; i < 40; i++) ...[
          {'type': 'user_message', 'payload': {'content': 'question $i'}},
          {'type': 'text_delta', 'payload': {'content': 'answer $i'}},
        ],
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

  testWidgets('the title stays in sight while the conversation is scrolled', (
    tester,
  ) async {
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

    // The conversation is what is on screen: there is no live terminal behind it.
    expect(find.byType(AgentConversationView), findsOneWidget);
    expect(find.text('question 39'), findsOneWidget);

    final title = find.byKey(const ValueKey('terminal-title'));
    expect(title, findsOneWidget);
    final before = tester.getRect(title);

    // Read back through the chat, the way somebody reads a chat. The list is
    // reversed (the newest at the bottom), so history is DOWNWARD.
    final list = find.descendant(
      of: find.byType(AgentConversationView),
      matching: find.byType(ListView),
    );
    expect(list, findsOneWidget);
    await tester.drag(list, const Offset(0, 600));
    await tester.pumpAndSettle();

    // The title is still there, in the same place: it did not slide off the top.
    expect(title, findsOneWidget);
    final after = tester.getRect(title);
    expect(after.top, greaterThanOrEqualTo(0));
    expect(after, before);

    // And the chat really did scroll — the title stayed while the messages moved.
    expect(find.text('question 39'), findsNothing);
    // The bubbles are SelectableText, so their words live in a controller.
    final questions = find.byWidgetPredicate(
      (w) => w is EditableText && w.controller.text.startsWith('question '),
    );
    final numbers = tester
        .widgetList<EditableText>(questions)
        .map((t) => int.parse(t.controller.text.split(' ').last))
        .toList();
    expect(numbers, isNotEmpty);
    expect(numbers.reduce((a, b) => a < b ? a : b), lessThan(39));
  });
}
