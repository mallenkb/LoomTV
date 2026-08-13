import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { reportNonFatal } from '../mobileDiagnostics';

type Props = {
  children: ReactNode;
  scope: string;
  title: string;
  message: string;
  resetKey?: string;
  onReset?: () => void;
};

type State = { error: Error | null };

export class MobileErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportNonFatal(this.props.scope, error, { componentStack: info.componentStack || '' });
  }

  componentDidUpdate(previousProps: Props): void {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private retry = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <View accessibilityRole="alert" style={styles.screen}>
        <Text selectable accessibilityRole="header" style={styles.title}>{this.props.title}</Text>
        <Text selectable style={styles.message}>{this.props.message}</Text>
        <Pressable
          accessibilityLabel="Retry"
          accessibilityRole="button"
          onPress={this.retry}
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        >
          <Text style={styles.buttonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  screen: { ...StyleSheet.absoluteFillObject, zIndex: 500, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 28, backgroundColor: '#0b0b0b' },
  title: { color: '#fff', fontSize: 24, fontWeight: '700', textAlign: 'center' },
  message: { maxWidth: 520, color: '#b7b7b7', fontSize: 16, lineHeight: 23, textAlign: 'center' },
  button: { minWidth: 120, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24, backgroundColor: '#fff', paddingHorizontal: 22 },
  buttonPressed: { opacity: 0.82 },
  buttonText: { color: '#000', fontSize: 16, fontWeight: '700' },
});
