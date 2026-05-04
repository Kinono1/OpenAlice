/**
 * Safe mathematical expression evaluation
 *
 * Only allows numbers and basic operators, preventing code injection
 */
export function calculate(expression: string): number {
  try {
    const result = new ArithmeticParser(expression).parse();
    if (typeof result !== 'number' || !isFinite(result)) {
      throw new Error('Invalid calculation result');
    }
    // Precision control: round to 4 decimal places
    return Math.round(result * 10000) / 10000;
  } catch (error) {
    throw new Error(
      `Calculation error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

class ArithmeticParser {
  private index = 0;

  constructor(private readonly expression: string) {
    if (expression.length > 4096) {
      throw new Error('Invalid expression: expression is too long');
    }
    if (!/^[\d+\-*/().\s]+$/.test(expression)) {
      throw new Error(
        'Invalid expression: only numbers and basic operators allowed',
      );
    }
  }

  parse(): number {
    const value = this.parseExpression();
    this.skipWhitespace();
    if (!this.isAtEnd()) {
      throw new Error(`Invalid expression: unexpected token "${this.peek()}"`);
    }
    return value;
  }

  private parseExpression(): number {
    let value = this.parseTerm();

    while (true) {
      this.skipWhitespace();
      if (this.match('+')) {
        value += this.parseTerm();
      } else if (this.match('-')) {
        value -= this.parseTerm();
      } else {
        return value;
      }
    }
  }

  private parseTerm(): number {
    let value = this.parseFactor();

    while (true) {
      this.skipWhitespace();
      if (this.match('*')) {
        value *= this.parseFactor();
      } else if (this.match('/')) {
        const divisor = this.parseFactor();
        if (divisor === 0) {
          throw new Error('Invalid calculation result');
        }
        value /= divisor;
      } else {
        return value;
      }
    }
  }

  private parseFactor(): number {
    this.skipWhitespace();
    if (this.match('+')) {
      return this.parseFactor();
    }
    if (this.match('-')) {
      return -this.parseFactor();
    }
    if (this.match('(')) {
      const value = this.parseExpression();
      this.skipWhitespace();
      if (!this.match(')')) {
        throw new Error('Invalid expression: missing closing parenthesis');
      }
      return value;
    }
    return this.parseNumber();
  }

  private parseNumber(): number {
    this.skipWhitespace();
    const start = this.index;
    let hasDigit = false;
    let hasDot = false;

    while (!this.isAtEnd()) {
      const ch = this.peek();
      if (ch >= '0' && ch <= '9') {
        hasDigit = true;
        this.index += 1;
      } else if (ch === '.' && !hasDot) {
        hasDot = true;
        this.index += 1;
      } else {
        break;
      }
    }

    if (!hasDigit) {
      throw new Error('Invalid expression: expected number');
    }

    const value = Number(this.expression.slice(start, this.index));
    if (!Number.isFinite(value)) {
      throw new Error('Invalid expression: invalid number');
    }
    return value;
  }

  private match(expected: string): boolean {
    if (this.peek() !== expected) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private skipWhitespace(): void {
    while (!this.isAtEnd() && /\s/.test(this.peek())) {
      this.index += 1;
    }
  }

  private peek(): string {
    return this.expression[this.index] ?? '';
  }

  private isAtEnd(): boolean {
    return this.index >= this.expression.length;
  }
}
