import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

enum _ConversationStatus { loading, ready, empty, error }

/// One rendered exchange: a person's request, the agent's answer, or a compact tool marker.
class ConversationMessage {
  const ConversationMessage.user(this.text)
    : role = ConversationRole.user,
      isTool = false;

  const ConversationMessage.assistant(this.text)
    : role = ConversationRole.assistant,
      isTool = false;

  const ConversationMessage.tool(this.text)
    : role = ConversationRole.assistant,
      isTool = true;

  final ConversationRole role;
  final String text;
  final bool isTool;
}

enum ConversationRole { user, assistant }

/// The daemon's native conversation, rendered for the phone.
///
/// This is deliberately not a terminal emulator. The daemon owns the transcript and the terminal
/// pane is only one projection of it; reading `session_get` lets the phone show useful content even
/// while a Herdr pane has no live terminal byte stream.
class AgentConversationView extends StatefulWidget {
  const AgentConversationView({
    super.key,
    required this.notifier,
    required this.machineId,
    required this.agentId,
    this.title,
  });

  final AppNotifier notifier;
  final String machineId;
  final String agentId;
  final String? title;

  @override
  State<AgentConversationView> createState() => AgentConversationViewState();
}

class AgentConversationViewState extends State<AgentConversationView> {
  _ConversationStatus _status = _ConversationStatus.loading;
  String? _error;
  List<ConversationMessage> _messages = const [];
  bool _hasMore = false;
  String? _oldestCursor;
  bool _loadingOlder = false;
  Timer? _refreshDebounce;

  @override
  void initState() {
    super.initState();
    widget.notifier.sessionPreviews.addListener(_previewChanged);
    unawaited(_load());
  }

  @override
  void didUpdateWidget(covariant AgentConversationView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.machineId != widget.machineId ||
        oldWidget.agentId != widget.agentId ||
        !identical(oldWidget.notifier, widget.notifier)) {
      oldWidget.notifier.sessionPreviews.removeListener(_previewChanged);
      widget.notifier.sessionPreviews.addListener(_previewChanged);
      _load();
    }
  }

  @override
  void dispose() {
    _refreshDebounce?.cancel();
    widget.notifier.sessionPreviews.removeListener(_previewChanged);
    super.dispose();
  }

  /// Live turn events update the preview store. Coalesce the burst into one transcript refresh;
  /// a long answer can emit many deltas per second.
  void _previewChanged() {
    _refreshDebounce?.cancel();
    _refreshDebounce = Timer(const Duration(milliseconds: 1200), () {
      if (mounted) unawaited(_load(showSpinner: false));
    });
  }

  Future<void> _load({bool showSpinner = true, bool older = false}) async {
    if (older) {
      if (_loadingOlder || _oldestCursor == null) return;
      _loadingOlder = true;
    } else if (showSpinner &&
        mounted &&
        _status != _ConversationStatus.loading) {
      setState(() {
        _status = _ConversationStatus.loading;
        _error = null;
      });
    }

    try {
      final reply = older
          ? await widget.notifier.conversationHistoryForAgent(
              widget.machineId,
              widget.agentId,
              before: _oldestCursor,
              limit: 80,
            )
          : await widget.notifier.conversationHistoryForAgent(
              widget.machineId,
              widget.agentId,
            );

      if (reply['error'] != null) {
        await _loadRecent(
          reply['error'] as String? ?? 'TRANSCRIPT_UNAVAILABLE',
        );
        return;
      }

      final parsed = _messagesFromHistory(reply);
      if (!mounted) return;
      setState(() {
        if (older) {
          final fresh = parsed
              .where(
                (message) => !_messages.any(
                  (existing) =>
                      existing.role == message.role &&
                      existing.isTool == message.isTool &&
                      existing.text == message.text,
                ),
              )
              .toList();
          _messages = [...fresh, ..._messages];
        } else {
          _messages = parsed;
        }
        _hasMore = reply['hasMore'] == true;
        _oldestCursor = reply['oldestCursor'] is String
            ? reply['oldestCursor'] as String
            : null;
        _loadingOlder = false;
        _status = _messages.isEmpty
            ? _ConversationStatus.empty
            : _ConversationStatus.ready;
        _error = null;
      });
    } catch (error) {
      await _loadRecent(error.toString());
    } finally {
      _loadingOlder = false;
    }
  }

  /// A shell or a brand-new agent has no transcript. The daemon can still say what the last
  /// turns did; show that rather than an empty screen.
  Future<void> _loadRecent(String reason) async {
    try {
      final reply = await widget.notifier.recentConversationForAgent(
        widget.machineId,
        widget.agentId,
      );
      final messages = _messagesFromRecent(reply);
      if (!mounted) return;
      setState(() {
        _messages = messages;
        _hasMore = false;
        _oldestCursor = null;
        _status = messages.isEmpty
            ? _ConversationStatus.empty
            : _ConversationStatus.ready;
        _error = messages.isEmpty ? reason : null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _status = _ConversationStatus.error;
        _error = error.toString();
      });
    }
  }

  static String _string(Object? value) => value is String ? value : '';

  static List<ConversationMessage> _messagesFromHistory(
    Map<String, dynamic> reply,
  ) {
    final events = reply['events'];
    if (events is! List) return const [];
    final messages = <ConversationMessage>[];
    var assistant = StringBuffer();

    void finishAssistant() {
      final text = assistant.toString().trim();
      if (text.isNotEmpty) messages.add(ConversationMessage.assistant(text));
      assistant = StringBuffer();
    }

    for (final item in events) {
      if (item is! Map) continue;
      final type = _string(item['type']);
      final payload = item['payload'];
      if (payload is! Map) continue;

      switch (type) {
        case 'user_message':
          final text = _string(payload['content']).trim();
          if (text.isNotEmpty) {
            finishAssistant();
            messages.add(ConversationMessage.user(text));
          }
        case 'turn_started':
          final text = _string(payload['userMessage']).trim();
          if (text.isNotEmpty) {
            finishAssistant();
            if (messages.isEmpty ||
                messages.last.role != ConversationRole.user) {
              messages.add(ConversationMessage.user(text));
            }
          }
        case 'text_delta':
          if (payload['commentary'] == true) continue;
          assistant.write(_string(payload['content']));
        case 'done':
          final text = _string(payload['result']).trim();
          if (text.isNotEmpty && assistant.isEmpty) {
            assistant.write(text);
          }
        case 'tool_start':
          finishAssistant();
          final tool = _string(payload['tool']).trim();
          if (tool.isNotEmpty) {
            messages.add(ConversationMessage.tool(tool));
          }
        case 'tool_end':
          final summary = _string(payload['summary']).trim();
          final tool = _string(payload['tool']).trim();
          // What the tool printed, not the one-line summary of it: the summary is the first line
          // of the same result, and a reader on a phone is here for the result.
          final result = _string(payload['output']).trim();
          final text = result.isNotEmpty ? result : summary;
          if (text.isNotEmpty) {
            if (messages.isNotEmpty &&
                messages.last.isTool &&
                messages.last.role == ConversationRole.assistant) {
              // The tool's own row is already there: fill it with what the tool printed. A tool
              // that printed nothing keeps that row as it is — "Bash" says more than
              // "Bash completed" does.
              final last = messages.removeLast();
              messages.add(ConversationMessage.tool(
                result.isNotEmpty ? '${last.text} — $result' : last.text,
              ));
            } else {
              messages.add(ConversationMessage.tool(
                result.isNotEmpty && tool.isNotEmpty
                    ? '$tool — $result'
                    : text,
              ));
            }
          }
        case 'subagent_finished':
          final summary = _string(payload['summary']).trim();
          if (summary.isNotEmpty) {
            finishAssistant();
            messages.add(ConversationMessage.tool(summary));
          }
      }
    }
    finishAssistant();
    return messages;
  }

  static List<ConversationMessage> _messagesFromRecent(
    Map<String, dynamic> reply,
  ) {
    final messages = <ConversationMessage>[];
    final asks = reply['asks'];
    if (asks is List) {
      for (final ask in asks) {
        final text = _string(ask).trim();
        if (text.isNotEmpty) messages.add(ConversationMessage.user(text));
      }
    }
    final events = reply['events'];
    if (events is List) {
      for (final event in events) {
        if (event is! Map || event['kind'] != 'summary') continue;
        final text = _string(event['fullText']).trim();
        final short = _string(event['text']).trim();
        final recap = _string(event['recap']).trim();
        final chosen = text.isNotEmpty
            ? text
            : short.isNotEmpty
            ? short
            : recap;
        if (chosen.isNotEmpty) {
          messages.add(ConversationMessage.assistant(chosen));
        }
      }
    }
    return messages;
  }

  Future<void> _refresh() => _load(showSpinner: false);

  @override
  Widget build(BuildContext context) {
    final title = widget.title;
    return Scaffold(
      backgroundColor: AppPalette.windowBg,
      appBar: title == null
          ? null
          : AppBar(
              backgroundColor: AppPalette.windowBg,
              surfaceTintColor: Colors.transparent,
              title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
            ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: switch (_status) {
          _ConversationStatus.loading => const Center(
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          _ConversationStatus.error => _StatusBody(
            icon: Icons.warning_amber_outlined,
            title: 'Conversation unavailable',
            detail: _error ?? 'The daemon did not answer.',
            actionLabel: 'Retry',
            action: () => unawaited(_load()),
          ),
          _ConversationStatus.empty => const _StatusBody(
            icon: Icons.chat_bubble_outline_outlined,
            title: 'No conversation yet',
            detail: 'This harness has no native transcript yet. Its terminal is still available.',
          ),
          _ConversationStatus.ready => _MessageList(
            messages: _messages,
            hasMore: _hasMore,
            loadingOlder: _loadingOlder,
            loadOlder: () => unawaited(_load(older: true, showSpinner: false)),
          ),
        },
      ),
    );
  }
}

class _MessageList extends StatelessWidget {
  const _MessageList({
    required this.messages,
    required this.hasMore,
    required this.loadingOlder,
    required this.loadOlder,
  });

  final List<ConversationMessage> messages;
  final bool hasMore;
  final bool loadingOlder;
  final VoidCallback loadOlder;

  @override
  Widget build(BuildContext context) {
    // Reverse gives the newest exchange at the bottom without a scroll jump after the first load.
    final rendered = messages.reversed.toList(growable: false);
    return ListView.builder(
      reverse: true,
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
      itemCount: rendered.length + (hasMore || loadingOlder ? 1 : 0),
      itemBuilder: (context, index) {
        if (index == rendered.length) {
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Center(
              child: hasMore
                  ? TextButton(
                      onPressed: loadOlder,
                      child: const Text('Load earlier'),
                    )
                  : const SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
            ),
          );
        }
        final message = rendered[index];
        if (message.isTool) return _ToolRow(text: message.text);
        return _MessageBubble(
          message: message,
          fromUser: message.role == ConversationRole.user,
        );
      },
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message, required this.fromUser});

  final ConversationMessage message;
  final bool fromUser;

  @override
  Widget build(BuildContext context) {
    final color = fromUser ? AppPalette.accent : AppGlass.bubbleFill;
    final foreground = fromUser ? Colors.white : AppPalette.textPrimary;
    return Align(
      alignment: fromUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.widthOf(context) * 0.82,
        ),
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(18),
            topRight: const Radius.circular(18),
            bottomLeft: Radius.circular(fromUser ? 18 : 5),
            bottomRight: Radius.circular(fromUser ? 5 : 18),
          ),
        ),
        child: SelectableText(
          message.text,
          style: TextStyle(color: foreground, fontSize: 15, height: 1.35),
        ),
      ),
    );
  }
}

class _ToolRow extends StatelessWidget {
  const _ToolRow({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 4),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: AppPalette.cardBg.withValues(alpha: .58),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        text,
        maxLines: 3,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: AppPalette.textSecondary,
          fontSize: 12,
          height: 1.25,
        ),
      ),
    );
  }
}

class _StatusBody extends StatelessWidget {
  const _StatusBody({
    required this.icon,
    required this.title,
    required this.detail,
    this.actionLabel,
    this.action,
  });

  final IconData icon;
  final String title;
  final String detail;
  final String? actionLabel;
  final VoidCallback? action;

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(32),
    children: [
      const SizedBox(height: 80),
      Icon(icon, size: 30, color: AppPalette.textSecondary),
      const SizedBox(height: 16),
      Text(
        title,
        textAlign: TextAlign.center,
        style: TextStyle(
          color: AppPalette.textPrimary,
          fontSize: 17,
          fontWeight: FontWeight.w600,
        ),
      ),
      const SizedBox(height: 8),
      Text(
        detail,
        textAlign: TextAlign.center,
        style: TextStyle(
          color: AppPalette.textSecondary,
          fontSize: 13,
          height: 1.35,
        ),
      ),
      if (action case final action?) ...[
        const SizedBox(height: 18),
        Center(
          child: TextButton(
            onPressed: action,
            child: Text(actionLabel ?? 'Retry'),
          ),
        ),
      ],
    ],
  );
}
