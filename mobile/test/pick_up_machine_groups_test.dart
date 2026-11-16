import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/desk_tab_filter_bar.dart';
import 'package:harness_mobile/phone/welcome/pick_up_page.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/pending_question.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

/// The pick-up screen answers "which computer was that on" — one heading per machine, and a chip
/// per machine to switch to it (owner, 2026-11-16: "我看是所有 session 都混在一个列表里边的对吧？
/// 可以优化么？分组，用机器分组？").
///
/// Find keeps the flat ranked list; this is the other screen ([PhoneSearchResults.groupByMachine]).
final _now = DateTime.now();

Agent _agent(String id, {int minutesAgo = 5, bool stopped = false}) => Agent(
  id: id,
  name: 'work · $id',
  title: null,
  sessionId: 'session-$id',
  status: stopped ? 'stopped' : 'active',
  engine: 'codex',
  project: const AgentProject(name: 'work', cwd: '/srv/work'),
  updatedAt: _now.subtract(Duration(minutes: minutesAgo)),
  terminalAvailable: !stopped,
);

MachineState _machine(String id, List<Agent> agents) =>
    MachineState(
        Machine(machineId: id, authMode: MachineAuthMode.remote, name: id),
      )
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = agents;

/// Never answers: the screen reaches the fleet on its first frame (`reachAllMachines`), and a test
/// has no fleet. ⚠️ Answering `{}` would be worse than silence — an empty `agents` list is a machine
/// saying it holds nothing, and the rows under it would be gone before the first assertion.
class _Quiet extends WsConn {
  _Quiet()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'box',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) => Completer<Map<String, dynamic>>().future;
}

AppNotifier _app(List<MachineState> machines) {
  final conn = _Quiet();
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    connectionForTest: (_) => conn,
  );
  app.machines = [for (final state in machines) state.machine];
  for (final state in machines) {
    app.machineStates[state.machine.machineId] = state;
  }
  return app;
}

/// A row's text, wherever the row draws it.
Finder _row(String text) => find.text(text, findRichText: true);

Finder _chip(String name) => find.descendant(
  of: find.byType(DeskTabFilterBar),
  matching: find.text(name),
);

void main() {
  Future<AppNotifier> open(WidgetTester tester, List<MachineState> machines) async {
    final app = _app(machines);
    addTearDown(app.dispose);
    await tester.pumpWidget(MaterialApp(home: PickUpPage(notifier: app)));
    await tester.pump();
    return app;
  }

  testWidgets('sessions are grouped under the computer they run on', (
    tester,
  ) async {
    await open(tester, [
      _machine('box', [_agent('1111'), _agent('2222', minutesAgo: 9)]),
      _machine('lab', [_agent('9999', minutesAgo: 2)]),
    ]);

    // One heading per computer, and the one holding the freshest harness heads the list — the
    // ranking still decides, the grouping only says which machine each row is on.
    expect(find.text('BOX'), findsOneWidget);
    expect(find.text('LAB'), findsOneWidget);
    expect(
      tester.getTopLeft(find.text('LAB')).dy,
      lessThan(tester.getTopLeft(_row('work · 9999')).dy),
    );
    expect(
      tester.getTopLeft(_row('work · 9999')).dy,
      lessThan(tester.getTopLeft(find.text('BOX')).dy),
    );
    expect(
      tester.getTopLeft(find.text('BOX')).dy,
      lessThan(tester.getTopLeft(_row('work · 1111')).dy),
    );
    // A row still says whose it is, under the heading as before.
    expect(_row('work · 1111'), findsOneWidget);
    expect(_row('work · 9999'), findsOneWidget);
  });

  testWidgets('a computer chip narrows the list to that machine', (tester) async {
    await open(tester, [
      _machine('box', [_agent('1111')]),
      _machine('lab', [_agent('9999')]),
    ]);
    expect(find.byKey(const ValueKey('computer-chips')), findsOneWidget);
    expect(_chip('box'), findsOneWidget);
    expect(_chip('lab'), findsOneWidget);

    await tester.tap(_chip('lab'));
    await tester.pump();

    expect(_row('work · 9999'), findsOneWidget);
    expect(_row('work · 1111'), findsNothing);
    // One machine left on screen, so its heading would only repeat the chip that chose it.
    expect(find.text('LAB'), findsNothing);

    // Back to every computer, and the other machine's sessions are back with it.
    await tester.tap(_chip('All computers'));
    await tester.pump();
    expect(_row('work · 1111'), findsOneWidget);
    expect(find.text('BOX'), findsOneWidget);
  });

  testWidgets('what needs you stays above the machines that hold it', (
    tester,
  ) async {
    final box = _machine('box', [_agent('1111'), _agent('2222')]);
    box.blockedAgents['2222'] = PendingQuestion(
      machineId: 'box',
      agentId: '2222',
      requestId: 'r',
      answerKey: 'q',
      prompt: 'q',
      options: const ['yes'],
      multi: false,
      since: _now,
    );
    await open(tester, [box, _machine('lab', [_agent('9999')])]);

    expect(find.text('needs you'), findsOneWidget);
    expect(
      tester.getTopLeft(find.text('needs you')).dy,
      lessThan(tester.getTopLeft(find.text('BOX')).dy),
    );
    // And it is drawn once: the writing under BOX are the rest, not a second copy of the asking
    // one (`2222` is in the section above, ungrouped).
    expect(_row('work · 2222'), findsOneWidget);
  });

  testWidgets('two computers at double type: the rail and the headings still fit', (
    tester,
  ) async {
    final app = _app([
      _machine('box', [_agent('1111'), _agent('2222')]),
      _machine('lab', [_agent('9999')]),
    ]);
    addTearDown(app.dispose);
    // Two rails and a heading per group is the one shape this screen did not have before; at a
    // phone's largest type it is where an overflow would land.
    await tester.pumpWidget(
      MaterialApp(
        home: MediaQuery(
          data: const MediaQueryData(textScaler: TextScaler.linear(2)),
          child: PickUpPage(notifier: app),
        ),
      ),
    );
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(find.text('BOX'), findsOneWidget);
    expect(find.text('LAB'), findsOneWidget);
  });

  testWidgets('one computer: no headings, no chip rail', (tester) async {
    await open(tester, [
      _machine('box', [_agent('1111'), _agent('2222')]),
    ]);

    expect(find.text('BOX'), findsNothing);
    expect(find.byKey(const ValueKey('computer-chips')), findsNothing);
    expect(_row('work · 1111'), findsOneWidget);
  });
}
