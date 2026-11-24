#include <stdio.h>
#include <stdlib.h>
#include <conio.h>
#include <setjmp.h>

#define maxSize 100
int counter = 0;

typedef struct human {
  int Age;
  struct human* next;
} human_t;

enum color { red, Green };

int Get_Value(int Number, int *ptr)
{
	int x=5;
  int a = 0, b = 1;
  if (Number > 5 && Number < 4) {
    printf("never\n");
  } else {
    printf("x");
  }
  // int old_value = 3;
  // printf("%d", old_value);
  if (!(Number < 16)) return 1;
  for (int i = 0; i < 10; i++)
  {
    for (int j = 0; j < 10; j++)
    {
      a+=i*j;
    }
  }
  int* data = malloc(sizeof(int) * 50);
  data = realloc(data, 100);
  FILE* f = fopen("x.txt", "r");
  fprintf(stderr, "error\n");
  if (a > 1)
  {
    if (b > 1)
    {
      if (a > 2)
      {
        if (b > 2)
        {
          if (a > 3)
          {
            if (b > 3)
            {
              if (a > 4)
              {
                printf("deep\n");
              }
            }
          }
        }
      }
    }
  }
  return a;
    b = 2;
}

void doStuff(int a1, int a2, int a3, int a4, int a5, int a6, int a7)
{
  static int calls = 0;
  calls++;
  goto end;
end:
  exit(1);
}

int main()
{
  int result = Get_Value(3, NULL); printf("%d", result);
  switch (result)
  {
    case 1: printf("one"); break;
  }
  return 0;
}
