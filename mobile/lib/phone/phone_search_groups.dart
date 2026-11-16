import 'phone_destination.dart';

/// One machine's agents, under one header — the Agents list's grouping.
///
/// ⚠️ **The search itself does NOT group.** It draws one flat ranked list, as
/// the desktop's box does: grouping fought the ranking it sat on, dragging a
/// folder's weaker rows up behind its best one. This is the other screen — a
/// list of everything, read "which machine was that on" rather than against a
/// query — and there a machine heading is what the eye needs.
class PhoneMachineGroup {
  const PhoneMachineGroup({
    required this.machineId,
    required this.machineName,
    required this.rows,
  });

  final String machineId;
  final String machineName;

  /// Never empty, in the order the rows arrived — so the ranking still decides
  /// what heads the group.
  final List<PhoneDestination> rows;
}

/// [rows] gathered under their machines, the machine holding the best row first.
///
/// ⚠️ **Both orders come from the order [rows] arrive in, and neither is sorted
/// here.** A group sits where its FIRST row arrived, and its rows keep arrival
/// order. Sorting again would be a second copy of the ranking rule, free to
/// disagree with the one the rest of the phone uses.
///
/// Rows that are not agents are left out; the agents list has no other kind.
List<PhoneMachineGroup> phoneMachineGroups(List<PhoneDestination> rows) {
  final groups = <String, List<PhoneDestination>>{};
  for (final row in rows) {
    // A harness, or a conversation Harness did not start: both ran on a machine, and the pick-up
    // screen groups the two together — it lists both. A machine, a project or a command did not.
    if (!row.isAgent && row.external == null) continue;
    final machineId = row.machineId;
    if (machineId == null) continue;
    (groups[machineId] ??= []).add(row);
  }
  return [
    for (final MapEntry(key: machineId, value: members) in groups.entries)
      PhoneMachineGroup(
        machineId: machineId,
        // The entry's own name where there is one; a conversation found by what was said keeps the
        // machine's name on its row instead.
        machineName: _nameOf(members.first, machineId),
        rows: members,
      ),
  ];
}

/// Every row across [groups], in the order they are drawn — what a pager opened
/// from one of them swipes along.
///
/// The pager walks this BY INDEX against what is on screen, so it has to be
/// built from the groups rather than from the ungrouped rows they were made of.
String _nameOf(PhoneDestination row, String machineId) {
  final name = (row.entry?.machineName ?? row.machineLabel).trim();
  return name.isEmpty ? machineId : name;
}

List<PhoneDestination> phoneMachineGroupedRows(
  List<PhoneMachineGroup> groups,
) => [for (final group in groups) ...group.rows];
