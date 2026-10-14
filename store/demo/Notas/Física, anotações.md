---
tags: [Estudos, Física]
---

# Anotações de física

A energia de repouso de um corpo é $E = mc^2$, onde $c$ é a velocidade da luz.

## Movimento harmônico

A posição de um oscilador simples ao longo do tempo:

$$
x(t) = A \cos(\omega t + \varphi)
$$

A frequência angular depende da mola e da massa: $\omega = \sqrt{k/m}$.

## Uma integral para revisar

$$
\int_0^{\infty} e^{-x^2}\, dx = \frac{\sqrt{\pi}}{2}
$$

> Revisar a dedução antes da prova de quinta.

```python
import math

def periodo(k, m):
    return 2 * math.pi * math.sqrt(m / k)
```
